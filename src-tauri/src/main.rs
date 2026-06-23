#![cfg_attr(
    target_os = "windows",
    windows_subsystem = "windows"
)]

use ssh2::Session;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::Path,
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
};
use tauri::Manager;
use socket2::{Socket, Domain, Type, Protocol};
use memmap2;
use once_cell::sync::Lazy;
use tauri::Emitter;
use serde::Serialize;
use uuid::Uuid;
use keyring::Entry;
use zeroize::{Zeroizing, ZeroizeOnDrop};

type Sender = mpsc::Sender<InputMessage>;

static SESS_TX: Lazy<Mutex<HashMap<String, Sender>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Keyboard-interactive authenticator that answers every prompt with the stored password.
/// Used as fallback when `userauth_password` is rejected (PAM / ChallengeResponseAuthentication).
#[derive(ZeroizeOnDrop)]
struct PasswordKbdAuth(String);

impl ssh2::KeyboardInteractivePrompt for PasswordKbdAuth {
    fn prompt<'a>(
        &mut self,
        _username: &str,
        _instructions: &str,
        prompts: &[ssh2::Prompt<'a>],
    ) -> Vec<String> {
        prompts.iter().map(|_| self.0.clone()).collect()
    }
}

enum InputMessage {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

#[derive(Serialize, Clone)]
struct SshOutput {
    session: String,
    output: String,
}

#[tauri::command]
fn start_ssh_session(
    app_handle: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    pass: String,
    cols: Option<u32>,
    rows: Option<u32>,
    key_path: Option<String>,
    key_passphrase: Option<String>,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<InputMessage>();
    {
        let mut map = SESS_TX.lock().unwrap();
        map.insert(session_id.clone(), tx);
    }

    let app = app_handle.clone();
    let session_id_clone = session_id.clone();
    thread::spawn(move || {
        let pass = Zeroizing::new(pass);
        let event_name = format!("ssh-output-{}", session_id_clone);
        let emit_err = |msg: String| {
            let _ = app.emit(&event_name, SshOutput { session: session_id_clone.clone(), output: msg });
        };
        let addr_str = format!("{}:{}", host, port);
        // Try parsing directly as IP:port first (avoids DNS for IP addresses)
        let tcp_result = addr_str.parse::<SocketAddr>()
            .map(|sock_addr| {
                TcpStream::connect_timeout(&sock_addr, Duration::from_secs(10))
                    .map_err(|e| e.to_string())
            })
            .unwrap_or_else(|_| {
                // Hostname: do DNS resolution then connect
                addr_str.to_socket_addrs()
                    .map_err(|e| e.to_string())
                    .and_then(|mut addrs| {
                        addrs.next().ok_or_else(|| "could not resolve host".to_string())
                    })
                    .and_then(|sock_addr| {
                        TcpStream::connect_timeout(&sock_addr, Duration::from_secs(10))
                            .map_err(|e| e.to_string())
                    })
            });
        match tcp_result {
            Ok(tcp) => {
                // session creation
                if let Ok(mut sess) = Session::new() {
                    // 15s timeout for all blocking SSH operations (handshake, auth, etc.)
                    sess.set_timeout(15_000);
                    sess.set_tcp_stream(tcp);
                    if let Err(e) = sess.handshake() {
                        emit_err(format!("handshake failed: {}", e));
                    } else {
                        let mut authed = false;
                        if let Some(ref kp) = key_path {
                            let pk = Path::new(kp);
                            let passphrase = key_passphrase.as_deref();
                            match sess.userauth_pubkey_file(&user, None, pk, passphrase) {
                                Ok(_) if sess.authenticated() => authed = true,
                                Err(e) => emit_err(format!("pubkey auth error: {}", e)),
                                _ => {}
                            }
                        }
                        if !authed {
                            // Try plain password auth first
                            let pwd_ok = sess.userauth_password(&user, &*pass)
                                .is_ok() && sess.authenticated();
                            if pwd_ok {
                                authed = true;
                            } else {
                                // Fallback: keyboard-interactive (PAM servers, ChallengeResponseAuthentication)
                                let mut kbd = PasswordKbdAuth((*pass).clone());
                                match sess.userauth_keyboard_interactive(&user, &mut kbd) {
                                    Ok(_) if sess.authenticated() => authed = true,
                                    Err(e) => emit_err(format!("\r\npassword auth error: {}\r\n", e)),
                                    _ => {}
                                }
                            }
                        }

                        if authed {
                            match sess.channel_session() {
                                Ok(mut channel) => {
                                    let c = cols.unwrap_or(80) as u32;
                                    let r = rows.unwrap_or(24) as u32;
                                    let _ = channel.request_pty("xterm", None, Some((c, r, 0, 0)));
                                    let _ = channel.shell();
                                    // Send SSH-level keepalive every 30s to prevent server-side idle drops
                                    let _ = sess.set_keepalive(true, 30);
                                    sess.set_blocking(false);
                                    // 64 KB: 2× the previous size — halves read() round-trips for
                                    // bulk output while staying well within libssh2's 2 MB channel window.
                                    let mut buf = [0u8; 65536];
                                    // Scratch buffer reused every read — avoids per-read Vec alloc.
                                    // +4 for the at-most-3-byte UTF-8 carry from the previous read.
                                    let mut raw: Vec<u8> = Vec::with_capacity(65536 + 4);
                                    // At most 3 bytes of an incomplete multi-byte UTF-8 sequence.
                                    let mut utf8_remainder: Vec<u8> = Vec::new();
                                    // Accumulates one batch of output; taken (not cloned) into each emit.
                                    let mut combined = String::new();
                                    let mut keepalive_timer = std::time::Instant::now();
                                    // Adaptive idle counter: counts consecutive ticks without any
                                    // I/O. Reset on output, input, or any work so an active session
                                    // stays snappy; ramps up when truly idle so the loop sleeps in
                                    // the kernel instead of busy-polling at 200 Hz.
                                    let mut idle_ticks: u32 = 0;
                                    loop {
                                        // Coalesce up to 16 consecutive reads into one IPC event to halve
                                        // frontend message overhead vs the previous 8-read limit.
                                        combined.clear();
                                        let mut got_data = false;
                                        for _ in 0..16 {
                                            match channel.read(&mut buf) {
                                                Ok(n) if n > 0 => {
                                                    got_data = true;
                                                    // Move remainder bytes into raw without cloning —
                                                    // append() is a memcpy of ≤3 bytes, never allocates.
                                                    raw.clear();
                                                    raw.append(&mut utf8_remainder);
                                                    raw.extend_from_slice(&buf[..n]);
                                                    // Find the largest valid UTF-8 prefix; carry the rest.
                                                    let valid_end = match std::str::from_utf8(&raw) {
                                                        Ok(_) => raw.len(),
                                                        Err(e) => e.valid_up_to(),
                                                    };
                                                    utf8_remainder.extend_from_slice(&raw[valid_end..]);
                                                    // SAFETY: valid_end is a valid UTF-8 boundary
                                                    debug_assert!(std::str::from_utf8(&raw[..valid_end]).is_ok(), "UTF-8 boundary miscalculated");
                                                    combined.push_str(unsafe { std::str::from_utf8_unchecked(&raw[..valid_end]) });
                                                }
                                                _ => break,
                                            }
                                        }
                                        if !combined.is_empty() {
                                            // take() moves the buffer into the event without copying;
                                            // combined is replaced with an empty String (no alloc here).
                                            let _ = app.emit(&event_name, SshOutput {
                                                session: session_id_clone.clone(),
                                                output: std::mem::take(&mut combined),
                                            });
                                        }

                                        // Drain all pending input in a single blocking window —
                                        // eliminates redundant set_blocking syscalls and ensures
                                        // pasted text is flushed atomically rather than chunk-per-tick.
                                        let mut should_close = false;
                                        let mut got_input = false;
                                        sess.set_blocking(true);
                                        loop {
                                            match rx.try_recv() {
                                                Ok(InputMessage::Data(d)) => {
                                                    got_input = true;
                                                    let _ = channel.write_all(&d);
                                                }
                                                Ok(InputMessage::Resize(c, r)) => {
                                                    got_input = true;
                                                    let _ = channel.request_pty_size(c, r, None, None);
                                                }
                                                Ok(InputMessage::Close) | Err(mpsc::TryRecvError::Disconnected) => {
                                                    should_close = true;
                                                    break;
                                                }
                                                Err(mpsc::TryRecvError::Empty) => break,
                                            }
                                        }
                                        let _ = channel.flush();
                                        sess.set_blocking(false);
                                        if should_close {
                                            sess.set_blocking(true);
                                            let _ = channel.close();
                                            break;
                                        }

                                        // Send SSH keepalive every 25s (before server's 30s idle timeout)
                                        if keepalive_timer.elapsed().as_secs() >= 25 {
                                            sess.set_blocking(true);
                                            let _ = sess.keepalive_send();
                                            sess.set_blocking(false);
                                            keepalive_timer = std::time::Instant::now();
                                        }

                                        if channel.eof() {
                                            break;
                                        }
                                        // Adaptive idle sleep — replaces fixed 5ms busy-poll.
                                        // Active or recently-active session stays at low latency;
                                        // truly idle session sleeps in the kernel for longer
                                        // intervals so per-session idle CPU drops well under 0.2%.
                                        if got_data || got_input {
                                            idle_ticks = 0;
                                            // No sleep — burst-process while data is flowing.
                                        } else {
                                            idle_ticks = idle_ticks.saturating_add(1);
                                            let sleep_ms = if idle_ticks < 20 {
                                                5    // <100ms idle: snappy
                                            } else if idle_ticks < 200 {
                                                20   // <1s idle: moderate
                                            } else {
                                                100  // long idle: kernel-sleep mostly
                                            };
                                            thread::sleep(Duration::from_millis(sleep_ms));
                                        }
                                    }
                                }
                                Err(err) => emit_err(format!("\r\nchannel error: {}\r\n", err)),
                            }
                        } else {
                            emit_err("\r\nauthentication failed\r\n".into());
                        }
                    }
                } else {
                    emit_err("\r\nsession init failed\r\n".into());
                }
            }
            Err(e) => emit_err(format!("\r\ntcp connect failed: {}\r\n", e)),
        }

        if let Ok(mut map) = SESS_TX.lock() { map.remove(&session_id_clone); }
        let _ = app.emit(&event_name, SshOutput { session: session_id_clone.clone(), output: "[disconnected]".into() });
    });

    Ok(session_id)
}

#[tauri::command]
fn send_ssh_input(session_id: String, input: String) -> Result<(), String> {
    let tx = SESS_TX.lock().map_err(|_| "lock poisoned".to_string())?.get(&session_id).cloned();
    match tx {
        Some(tx) => tx.send(InputMessage::Data(input.into_bytes())).map_err(|e| e.to_string()),
        None => Err("session not found".into()),
    }
}

#[tauri::command]
fn resize_pty(session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    let tx = SESS_TX.lock().map_err(|_| "lock poisoned".to_string())?.get(&session_id).cloned();
    match tx {
        Some(tx) => tx.send(InputMessage::Resize(cols, rows)).map_err(|e| e.to_string()),
        None => Err("session not found".into()),
    }
}

#[tauri::command]
fn get_remote_cwd(
    host: String,
    port: u16,
    user: String,
    pass: String,
    key_path: Option<String>,
) -> Result<String, String> {
    let addr_str = format!("{}:{}", host, port);
    let sock_addr: SocketAddr = addr_str
        .parse()
        .or_else(|_| {
            addr_str
                .to_socket_addrs()
                .map_err(|e| e.to_string())
                .and_then(|mut a| a.next().ok_or_else(|| "could not resolve host".into()))
        })
        .map_err(|e| e.to_string())?;

    let tcp = TcpStream::connect_timeout(&sock_addr, Duration::from_secs(8))
        .map_err(|e| e.to_string())?;

    let mut sess = Session::new().map_err(|e| e.to_string())?;
    sess.set_timeout(8_000);
    sess.set_tcp_stream(tcp);
    sess.handshake().map_err(|e| e.to_string())?;

    let pass = Zeroizing::new(pass);
    let mut authed = false;
    if let Some(ref kp) = key_path {
        let pk = Path::new(kp);
        if sess.userauth_pubkey_file(&user, None, pk, None).is_ok() && sess.authenticated() {
            authed = true;
        }
    }
    if !authed {
        if sess.userauth_password(&user, &*pass).is_ok() && sess.authenticated() {
            authed = true;
        }
    }
    if !authed {
        let mut kbd = PasswordKbdAuth((*pass).clone());
        if sess.userauth_keyboard_interactive(&user, &mut kbd).is_ok() && sess.authenticated() {
            authed = true;
        }
    }
    if !authed {
        return Err("authentication failed".into());
    }

    let mut channel = sess.channel_session().map_err(|e| e.to_string())?;
    channel.exec("pwd").map_err(|e| e.to_string())?;
    let mut output = String::new();
    channel.read_to_string(&mut output).map_err(|e| e.to_string())?;
    channel.wait_close().ok();

    Ok(output.trim().to_string())
}

#[tauri::command]
fn stop_ssh_session(session_id: String) -> Result<(), String> {
    let tx = SESS_TX.lock().map_err(|_| "lock poisoned".to_string())?.remove(&session_id);
    if let Some(tx) = tx {
        tx.send(InputMessage::Close).map_err(|e| e.to_string())?;
    }
    Ok(())
}



#[derive(Serialize, Clone)]
struct SCPProgress {
    id: String,
    bytes_sent: u64,
    total: u64,
    done: bool,
    error: Option<String>,
    remote_path: Option<String>,
    protocol: String,
}

#[tauri::command]
fn upload_file_scp(
    app_handle: tauri::AppHandle,
    transfer_id: String,
    host: String,
    port: u16,
    user: String,
    pass: String,
    key_path: Option<String>,
    local_path: String,
    remote_dir: String,
) -> Result<(), String> {
    // Emit immediately so the UI registers the transfer before the thread even starts
    let _ = app_handle.emit("SCP-progress", SCPProgress {
        id: transfer_id.clone(),
        bytes_sent: 0,
        total: 0,
        done: false,
        error: None,
        remote_path: None,
        protocol: "scp".to_string(),
    });
    thread::spawn(move || {
        let pass = Zeroizing::new(pass);
        let result = do_scp_upload(
            &app_handle, &transfer_id, &host, port, &user, &*pass,
            key_path.as_deref(), &local_path, &remote_dir,
        );
        if let Err(e) = result {
            let _ = app_handle.emit("SCP-progress", SCPProgress {
                id: transfer_id,
                bytes_sent: 0,
                total: 0,
                done: true,
                error: Some(e),
                remote_path: None,
                protocol: "error".to_string(),
            });
        }
    });
    Ok(())
}

/// SCP upload
fn do_scp_upload(
    app: &tauri::AppHandle,
    transfer_id: &str,
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
    key_path: Option<&str>,
    local_path: &str,
    remote_dir: &str,
) -> Result<(), String> {
    // Tuned TCP socket: 4 MB send buffer keeps the kernel pipeline full
    // ahead of the SSH encryption cycle; nodelay kills Nagle latency.
    let addr: SocketAddr = format!("{}:{}", host, port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("Could not resolve host")?;
    let domain = if addr.is_ipv6() { Domain::IPV6 } else { Domain::IPV4 };
    let raw = Socket::new(domain, Type::STREAM, Some(Protocol::TCP)).map_err(|e| e.to_string())?;
    raw.set_nodelay(true).ok();
    raw.set_send_buffer_size(4 * 1024 * 1024).ok();
    raw.set_recv_buffer_size(512 * 1024).ok();
    raw.connect(&addr.into()).map_err(|e| e.to_string())?;
    let tcp: TcpStream = raw.into();

    let mut sess = Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    sess.handshake().map_err(|e| e.to_string())?;

    let mut authed = false;
    if let Some(kp) = key_path {
        if sess.userauth_pubkey_file(user, None, Path::new(kp), None).is_ok() && sess.authenticated() {
            authed = true;
        }
    }
    if !authed {
        let pwd_ok = sess.userauth_password(user, pass).is_ok() && sess.authenticated();
        if pwd_ok {
            authed = true;
        } else {
            // Keyboard-interactive fallback for PAM / ChallengeResponseAuthentication servers,
            // matching the same auth chain used by start_ssh_session.
            let mut kbd = PasswordKbdAuth(pass.to_string());
            if sess.userauth_keyboard_interactive(user, &mut kbd).is_ok() && sess.authenticated() {
                authed = true;
            }
        }
    }
    if !authed {
        return Err("SCP authentication failed".into());
    }

    use std::fs::File;

    let total = std::fs::metadata(local_path).map_err(|e| e.to_string())?.len();

    let filename = Path::new(local_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Construct full remote path: ensure the directory exists via a channel exec,
    // then let scp_send handle the rest natively.
    let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), filename);

    // mkdir -p the remote dir (best-effort — some servers may not have mkdir)
    {
        let safe_dir = remote_dir.replace('\'', "'\\''");
        let mut mkdir_ch = sess.channel_session().map_err(|e| e.to_string())?;
        let _ = mkdir_ch.exec(&format!("mkdir -p '{safe_dir}'"));
        let _ = mkdir_ch.wait_close();
    }

    // Emit 0% / Connecting state immediately
    let _ = app.emit("SCP-progress", SCPProgress {
        id: transfer_id.to_string(),
        bytes_sent: 0,
        total,
        done: false,
        error: None,
        remote_path: None,
        protocol: "scp".to_string(),
    });

    // Use libssh2's native scp_send — handles all C0644 header + ACK handshake
    // internally at the C level. No manual \0 reads, no protocol drift, no corruption.
    let mut channel = sess
        .scp_send(Path::new(&remote_path), 0o644, total, None)
        .map_err(|e| format!("SCP open failed: {}", e))?;

    // 128 KB write chunks: fits within libssh2's 2 MB channel window so
    // the window never drains and causes a blocking stall.
    const WRITE_CHUNK: usize = 131_072;
    const PROGRESS_INTERVAL: u64 = 524_288; // emit every 512 KB

    let mut offset: u64 = 0;
    let mut last_progress: u64 = 0;

    if total > 0 {
        let file = File::open(local_path).map_err(|e| e.to_string())?;
        // Memory-map: OS prefetches pages into RAM; zero kernel→user copies.
        // SAFETY: file is not modified during transfer, mapping is read-only.
        let mmap = unsafe { memmap2::Mmap::map(&file) }.map_err(|e| e.to_string())?;

        for chunk in mmap.chunks(WRITE_CHUNK) {
            channel.write_all(chunk).map_err(|e| format!("SCP write error: {}", e))?;
            offset += chunk.len() as u64;

            if offset - last_progress >= PROGRESS_INTERVAL || offset >= total {
                last_progress = offset;
                let _ = app.emit("SCP-progress", SCPProgress {
                    id: transfer_id.to_string(),
                    bytes_sent: offset,
                    total,
                    done: false,
                    error: None,
                    remote_path: None,
                    protocol: "scp".to_string(),
                });
            }
        }
    }

    // Flush any internally buffered write data before declaring EOF.
    // Without this, libssh2 may leave data in its send buffer and the server
    // receives a truncated file — manifests as corrupted archives/indexes.
    channel.flush().map_err(|e| e.to_string())?;
    // Proper close sequence — libssh2 sends EOF + waits for server confirmation.
    channel.send_eof().map_err(|e| e.to_string())?;
    channel.wait_eof().map_err(|e| e.to_string())?;
    channel.close().map_err(|e| e.to_string())?;
    channel.wait_close().map_err(|e| e.to_string())?;

    let _ = app.emit("SCP-progress", SCPProgress {
        id: transfer_id.to_string(),
        bytes_sent: total,
        total,
        done: true,
        error: None,
        remote_path: Some(remote_path),
        protocol: "scp".to_string(),
    });
    Ok(())
}


/// Store a password in the OS keychain (Windows Credential Manager / macOS Keychain / SecretService)
#[tauri::command]
fn set_credential(id: String, password: String) -> Result<(), String> {
    let password = Zeroizing::new(password);
    Entry::new("atlas", &id)
        .map_err(|e| e.to_string())?
        .set_password(&*password)
        .map_err(|e| e.to_string())
}

/// Retrieve a password from the OS keychain. Returns None if not found.
#[tauri::command]
fn get_credential(id: String) -> Result<Option<String>, String> {
    let entry = Entry::new("atlas", &id).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a password from the OS keychain. Silently succeeds if not found.
#[tauri::command]
fn delete_credential(id: String) -> Result<(), String> {
    let entry = Entry::new("atlas", &id).map_err(|e| e.to_string())?;
    match entry.delete_password() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Read a value from the persistent app-data store.
/// Files live in {app_data_dir}/store/{key} and survive reinstalls, WebView2
/// profile wipes, and origin changes (tauri:// vs http://localhost).
#[tauri::command]
fn read_store(app_handle: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = data_dir.join("store").join(&key);
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Write a value to the persistent app-data store.
#[tauri::command]
fn write_store(app_handle: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let store_dir = data_dir.join("store");
    fs::create_dir_all(&store_dir).map_err(|e| e.to_string())?;
    let path = store_dir.join(&key);
    // Write to a temp file then rename so a crash mid-write never corrupts the store
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &value).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn debug_log(message: String) -> Result<(), String> {
    println!("{}", message);
    Ok(())
}

#[tauri::command]
fn export_to_file(content: String, default_name: String) -> Result<Option<String>, String> {
    let path = rfd::FileDialog::new()
        .set_file_name(&default_name)
        .add_filter("JSON", &["json"])
        .save_file();
    match path {
        Some(p) => {
            std::fs::write(&p, content).map_err(|e| e.to_string())?;
            Ok(Some(p.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn import_from_file() -> Result<Option<String>, String> {
    let path = rfd::FileDialog::new()
        .add_filter("JSON", &["json"])
        .pick_file();
    match path {
        Some(p) => {
            let content = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
            Ok(Some(content))
        }
        None => Ok(None),
    }
}

fn main() {
    tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_clipboard_manager::init())
    .invoke_handler(tauri::generate_handler![
        start_ssh_session,
        send_ssh_input,
        stop_ssh_session,
        get_remote_cwd,
        resize_pty,
        upload_file_scp,
        set_credential,
        get_credential,
        delete_credential,
        read_store,
        write_store,
        debug_log,
        export_to_file,
        import_from_file,
    ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
