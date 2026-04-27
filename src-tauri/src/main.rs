#![cfg_attr(
    target_os = "windows",
    windows_subsystem = "windows"
)]

use ssh2::Session;
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::Path,
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
};
use once_cell::sync::Lazy;
use tauri::Emitter;
use serde::Serialize;
use uuid::Uuid;
use keyring::Entry;

type Sender = mpsc::Sender<InputMessage>;

static SESS_TX: Lazy<Mutex<HashMap<String, Sender>>> = Lazy::new(|| Mutex::new(HashMap::new()));



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
                        let _ = app.emit(format!("ssh-output-{}", session_id_clone).as_str(), SshOutput { session: session_id_clone.clone(), output: format!("handshake failed: {}", e) });
                    } else {
                        let mut authed = false;
                        if let Some(kp) = key_path.clone() {
                            let pk = Path::new(&kp);
                            let passphrase = key_passphrase.as_deref();
                            match sess.userauth_pubkey_file(&user, None, pk, passphrase) {
                                Ok(_) if sess.authenticated() => authed = true,
                                Err(e) => {
                                                    let _ = app.emit(format!("ssh-output-{}", session_id_clone).as_str(), SshOutput { session: session_id_clone.clone(), output: format!("pubkey auth error: {}", e) });
                                                }
                                _ => {}
                            }
                        }
                        if !authed {
                            match sess.userauth_password(&user, &pass) {
                                Ok(_) if sess.authenticated() => authed = true,
                                Err(e) => {
                                                    let _ = app.emit(format!("ssh-output-{}", session_id_clone).as_str(), SshOutput { session: session_id_clone.clone(), output: format!("\r\npassword auth error: {}\r\n", e) });
                                                }
                                _ => {}
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
                                    let mut buf = [0u8; 32768];
                                    // Incomplete multi-byte UTF-8 sequence carried over from last read
                                    let mut utf8_remainder: Vec<u8> = Vec::new();
                                    let mut keepalive_timer = std::time::Instant::now();
                                    loop {
                                        // Coalesce consecutive reads into one IPC event to reduce
                                        // frontend message overhead during high-throughput output.
                                        let mut combined = String::new();
                                        let mut got_data = false;
                                        for _ in 0..8 {
                                            match channel.read(&mut buf) {
                                                Ok(n) if n > 0 => {
                                                    got_data = true;
                                                    // Prepend any leftover bytes from the previous read
                                                    let mut raw = utf8_remainder.clone();
                                                    raw.extend_from_slice(&buf[..n]);
                                                    utf8_remainder.clear();
                                                    // Find the largest valid UTF-8 prefix; carry the rest
                                                    let valid_end = match std::str::from_utf8(&raw) {
                                                        Ok(_) => raw.len(),
                                                        Err(e) => e.valid_up_to(),
                                                    };
                                                    utf8_remainder.extend_from_slice(&raw[valid_end..]);
                                                    // SAFETY: valid_end is a valid UTF-8 boundary
                                                    combined.push_str(unsafe { std::str::from_utf8_unchecked(&raw[..valid_end]) });
                                                }
                                                _ => break,
                                            }
                                        }
                                        if !combined.is_empty() {
                                            let event_name = format!("ssh-output-{}", session_id_clone);
                                            let _ = app.emit(event_name.as_str(), SshOutput { session: session_id_clone.clone(), output: combined });
                                        }

                                        match rx.try_recv() {
                                            Ok(InputMessage::Data(d)) => {
                                                sess.set_blocking(true);
                                                let _ = channel.write_all(&d);
                                                let _ = channel.flush();
                                                sess.set_blocking(false);
                                            }
                                            Ok(InputMessage::Resize(c, r)) => {
                                                sess.set_blocking(true);
                                                let _ = channel.request_pty_size(c, r, None, None);
                                                sess.set_blocking(false);
                                            }
                                            Ok(InputMessage::Close) | Err(mpsc::TryRecvError::Disconnected) => {
                                                sess.set_blocking(true);
                                                let _ = channel.close();
                                                break;
                                            }
                                            Err(mpsc::TryRecvError::Empty) => {}
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
                                        // Adaptive sleep: skip delay when data is flowing to reduce latency
                                        if !got_data {
                                            thread::sleep(Duration::from_millis(5));
                                        }
                                    }
                                }
                                Err(err) => {
                                    let _ = app.emit(format!("ssh-output-{}", session_id_clone).as_str(), SshOutput { session: session_id_clone.clone(), output: format!("\r\nchannel error: {}\r\n", err) });
                                }
                            }
                        } else {
                            let _ = app.emit(format!("ssh-output-{}", session_id_clone).as_str(), SshOutput { session: session_id_clone.clone(), output: "\r\nauthentication failed\r\n".into() });
                        }
                    }
                } else {
                    let _ = app.emit(format!("ssh-output-{}", session_id_clone).as_str(), SshOutput { session: session_id_clone.clone(), output: "\r\nsession init failed\r\n".into() });
                }
            }
            Err(e) => {
                let _ = app.emit(format!("ssh-output-{}", session_id_clone).as_str(), SshOutput { session: session_id_clone.clone(), output: format!("\r\ntcp connect failed: {}\r\n", e) });
            }
        }

        if let Ok(mut map) = SESS_TX.lock() { map.remove(&session_id_clone); }
        let _ = app.emit(format!("ssh-output-{}", session_id_clone).as_str(), SshOutput { session: session_id_clone.clone(), output: "[disconnected]".into() });
    });

    Ok(session_id)
}

#[tauri::command]
fn send_ssh_input(session_id: String, input: String) -> Result<(), String> {
    let map = SESS_TX.lock().map_err(|_| "lock poisoned".to_string())?;
    if let Some(tx) = map.get(&session_id) {
        tx.send(InputMessage::Data(input.into_bytes())).map_err(|e| e.to_string())
    } else {
        Err("session not found".into())
    }
}

#[tauri::command]
fn resize_pty(session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    let map = SESS_TX.lock().map_err(|_| "lock poisoned".to_string())?;
    if let Some(tx) = map.get(&session_id) {
        tx.send(InputMessage::Resize(cols, rows)).map_err(|e| e.to_string())
    } else {
        Err("session not found".into())
    }
}

#[tauri::command]
fn stop_ssh_session(session_id: String) -> Result<(), String> {
    let mut map = SESS_TX.lock().map_err(|_| "lock poisoned".to_string())?;
    if let Some(tx) = map.remove(&session_id) {
        tx.send(InputMessage::Close).map_err(|e| e.to_string())?;
    }
    Ok(())
}



#[derive(Serialize, Clone)]
struct SftpProgress {
    id: String,
    bytes_sent: u64,
    total: u64,
    done: bool,
    error: Option<String>,
    remote_path: Option<String>,
    protocol: String,
}

#[tauri::command]
fn upload_file_sftp(
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
    let _ = app_handle.emit("sftp-progress", SftpProgress {
        id: transfer_id.clone(),
        bytes_sent: 0,
        total: 0,
        done: false,
        error: None,
        remote_path: None,
        protocol: "scp".to_string(),
    });
    thread::spawn(move || {
        let result = do_scp_upload(
            &app_handle, &transfer_id, &host, port, &user, &pass,
            key_path.as_deref(), &local_path, &remote_dir,
        );
        if let Err(e) = result {
            let _ = app_handle.emit("sftp-progress", SftpProgress {
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
    let tcp = TcpStream::connect(format!("{}:{}", host, port)).map_err(|e| e.to_string())?;
    // Disable Nagle's algorithm: reduces latency for the many small SCP protocol writes
    tcp.set_nodelay(true).ok();
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
        sess.userauth_password(user, pass).map_err(|e| e.to_string())?;
        if !sess.authenticated() {
            return Err("SCP authentication failed".into());
        }
    }

    use std::fs::File;
    use std::io::BufReader;

    let total = std::fs::metadata(local_path).map_err(|e| e.to_string())?.len();

    let filename = Path::new(local_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Sanitise remote_dir for shell safety: wrap in single quotes, escape embedded single quotes.
    // This prevents path injection and handles spaces/special characters.
    let safe_dir = remote_dir.replace('\'', "'\\''"  );
    // Resolve ~ on the remote side via the shell before invoking scp sink.
    // The command expands the path then hands off to the scp sink protocol.
    let scp_cmd = format!("D='{safe_dir}'; mkdir -p \"$D\" 2>/dev/null; scp -t \"$D\"");
    let mut channel = sess.channel_session().map_err(|e| e.to_string())?;
    channel.exec(&scp_cmd).map_err(|e| format!("SCP exec failed: {}", e))?;

    // SCP protocol: send "C0644 <size> <filename>\n"
    let scp_header = format!("C0644 {} {}\n", total, filename);
    channel.write_all(scp_header.as_bytes()).map_err(|e| e.to_string())?;

    // Emit 0% immediately so the UI shows the transfer as started
    let _ = app.emit("sftp-progress", SftpProgress {
        id: transfer_id.to_string(),
        bytes_sent: 0,
        total,
        done: false,
        error: None,
        remote_path: None,
        protocol: "scp".to_string(),
    });

    // Stream file in 4MB chunks — avoids loading the entire file into RAM
    const CHUNK_SIZE: usize = 4194304;
    const PROGRESS_INTERVAL: u64 = 524288; // emit every 512KB

    let file = File::open(local_path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::with_capacity(CHUNK_SIZE, file);
    let mut offset: u64 = 0;
    let mut last_progress: u64 = 0;
    let mut chunk_buf = vec![0u8; CHUNK_SIZE];

    loop {
        use std::io::Read as _;
        let n = reader.read(&mut chunk_buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        channel.write_all(&chunk_buf[..n]).map_err(|e| e.to_string())?;
        offset += n as u64;

        if offset - last_progress >= PROGRESS_INTERVAL || offset >= total {
            last_progress = offset;
            let _ = app.emit("sftp-progress", SftpProgress {
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

    // SCP protocol: send null byte to signal EOF
    channel.write_all(&[0]).map_err(|e| e.to_string())?;
    channel.flush().map_err(|e| e.to_string())?;

    // Wait for SCP to acknowledge
    let mut buf = [0u8; 1];
    let _ = channel.read(&mut buf);

    let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), filename);
    let _ = app.emit("sftp-progress", SftpProgress {
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
    Entry::new("atlas", &id)
        .map_err(|e| e.to_string())?
        .set_password(&password)
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

#[tauri::command]
fn debug_log(message: String) -> Result<(), String> {
    println!("{}", message);
    Ok(())
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
        resize_pty,
        upload_file_sftp,
        set_credential,
        get_credential,
        delete_credential,
        debug_log,
    ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
