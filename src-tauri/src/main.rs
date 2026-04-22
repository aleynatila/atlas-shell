#![cfg_attr(
    target_os = "windows",
    windows_subsystem = "windows"
)]

use ssh2::{OpenFlags, OpenType, Session};
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
                                                    combined.push_str(&String::from_utf8_lossy(&buf[..n]));
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

        SESS_TX.lock().unwrap().remove(&session_id_clone);
        let _ = app.emit(format!("ssh-output-{}", session_id_clone).as_str(), SshOutput { session: session_id_clone.clone(), output: "[disconnected]".into() });
    });

    Ok(session_id)
}

#[tauri::command]
fn send_ssh_input(session_id: String, input: String) -> Result<(), String> {
    let map = SESS_TX.lock().unwrap();
    if let Some(tx) = map.get(&session_id) {
        tx.send(InputMessage::Data(input.into_bytes())).map_err(|e| e.to_string())
    } else {
        Err("session not found".into())
    }
}

#[tauri::command]
fn resize_pty(session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    let map = SESS_TX.lock().unwrap();
    if let Some(tx) = map.get(&session_id) {
        tx.send(InputMessage::Resize(cols, rows)).map_err(|e| e.to_string())
    } else {
        Err("session not found".into())
    }
}

#[tauri::command]
fn stop_ssh_session(session_id: String) -> Result<(), String> {
    let mut map = SESS_TX.lock().unwrap();
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
    thread::spawn(move || {
        // Fallback chain: rsync (fastest, key-auth only) → SCP → SFTP
        let result = if let Some(ref kp) = key_path {
            do_rsync_upload(
                &app_handle, &transfer_id, &host, port, &user, kp, &local_path, &remote_dir,
            ).or_else(|_| do_scp_upload(
                &app_handle, &transfer_id, &host, port, &user, &pass,
                Some(kp.as_str()), &local_path, &remote_dir,
            ))
        } else {
            do_scp_upload(
                &app_handle, &transfer_id, &host, port, &user, &pass,
                None, &local_path, &remote_dir,
            )
        }.or_else(|_| {
            do_sftp_upload(
                &app_handle, &transfer_id, &host, port, &user, &pass,
                key_path.as_deref(), &local_path, &remote_dir,
            )
        });
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

/// Parse a rsync --info=progress2 progress line.
/// Example: "    1,048,576  50%  10.50MB/s    0:00:01"
fn parse_rsync_progress_line(line: &str) -> Option<(u64, u8)> {
    let parts: Vec<&str> = line.trim().split_whitespace().collect();
    if parts.len() >= 2 {
        let bytes = parts[0].replace(',', "").parse::<u64>().ok()?;
        let pct = parts[1].trim_end_matches('%').parse::<u8>().ok()?;
        return Some((bytes, pct));
    }
    None
}

/// Rsync upload using bundled cwRsync (requires key-based SSH auth).
/// Falls back gracefully when rsync.exe is not bundled or remote lacks rsync.
fn do_rsync_upload(
    app: &tauri::AppHandle,
    transfer_id: &str,
    host: &str,
    port: u16,
    user: &str,
    key_path: &str,
    local_path: &str,
    remote_dir: &str,
) -> Result<(), String> {
    use tauri::Manager;
    use std::process::{Command, Stdio};

    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let rsync_exe = resource_dir.join("bin").join("rsync.exe");
    let ssh_exe = resource_dir.join("bin").join("ssh.exe");

    if !rsync_exe.exists() {
        return Err("rsync.exe not bundled".into());
    }

    let total = std::fs::metadata(local_path).map_err(|e| e.to_string())?.len();

    // Build -e ssh command; use bundled ssh.exe + forward-slash paths for cygwin
    let ssh_bin = if ssh_exe.exists() {
        ssh_exe.to_string_lossy().replace('\\', "/").to_string()
    } else {
        "ssh".to_string()
    };
    let key_fwd = key_path.replace('\\', "/");
    let ssh_cmd = format!(
        "{} -i {} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p {}",
        ssh_bin, key_fwd, port
    );
    let remote_target = format!("{}@{}:{}/", user, host, remote_dir.trim_end_matches('/'));
    let bin_dir = resource_dir.join("bin").to_string_lossy().to_string();
    let path_env = format!("{};{}", bin_dir, std::env::var("PATH").unwrap_or_default());

    let mut child = Command::new(&rsync_exe)
        .args([
            "-az",
            "--info=progress2",
            "--partial",
            "--inplace",
            "-e", &ssh_cmd,
            local_path,
            &remote_target,
        ])
        .env("PATH", &path_env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("rsync spawn: {}", e))?;

    // Read stdout; rsync uses \r to update progress in-place
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr_pipe = child.stderr.take();
    let mut read_buf = [0u8; 4096];
    let mut line_buf: Vec<u8> = Vec::new();

    loop {
        let n = stdout.read(&mut read_buf).unwrap_or(0);
        if n == 0 { break; }
        for &b in &read_buf[..n] {
            if b == b'\r' || b == b'\n' {
                if !line_buf.is_empty() {
                    let line = String::from_utf8_lossy(&line_buf).to_string();
                    if let Some((bytes, _)) = parse_rsync_progress_line(&line) {
                        let _ = app.emit("sftp-progress", SftpProgress {
                            id: transfer_id.to_string(),
                            bytes_sent: bytes,
                            total,
                            done: false,
                            error: None,
                            remote_path: None,
                            protocol: "rsync".to_string(),
                        });
                    }
                    line_buf.clear();
                }
            } else {
                line_buf.push(b);
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let mut stderr_out = String::new();
        if let Some(ref mut se) = stderr_pipe {
            let _ = se.read_to_string(&mut stderr_out);
        }
        return Err(format!("rsync ({}): {}", status, stderr_out.trim()));
    }

    let filename = Path::new(local_path).file_name().unwrap_or_default().to_string_lossy();
    let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), filename);
    let _ = app.emit("sftp-progress", SftpProgress {
        id: transfer_id.to_string(),
        bytes_sent: total,
        total,
        done: true,
        error: None,
        remote_path: Some(remote_path),
        protocol: "rsync".to_string(),
    });
    Ok(())
}

fn do_sftp_upload(
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
    use std::fs;
    let tcp = TcpStream::connect(format!("{}:{}", host, port)).map_err(|e| e.to_string())?;
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
            return Err("SFTP authentication failed".into());
        }
    }

    let sftp = sess.sftp().map_err(|e| e.to_string())?;

    // Resolve ~ to actual home directory
    let resolved_dir = if remote_dir == "~" || remote_dir.starts_with("~/") {
        let home = sftp.realpath(Path::new(".")).map_err(|e| e.to_string())?;
        let home_str = home.to_string_lossy().to_string();
        if remote_dir == "~" {
            home_str
        } else {
            format!("{}/{}", home_str, &remote_dir[2..])
        }
    } else {
        remote_dir.to_string()
    };

    // Ensure remote directory exists (create recursively)
    {
        let mut cumulative = String::new();
        for part in resolved_dir.split('/') {
            if part.is_empty() {
                cumulative.push('/');
                continue;
            }
            if !cumulative.is_empty() && !cumulative.ends_with('/') {
                cumulative.push('/');
            }
            cumulative.push_str(part);
            let _ = sftp.mkdir(Path::new(&cumulative), 0o755);
        }
    }

    let local_data = fs::read(local_path).map_err(|e| e.to_string())?;
    let total = local_data.len() as u64;

    let filename = Path::new(local_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let remote_file_path = format!("{}/{}", resolved_dir.trim_end_matches('/'), filename);

    let mut remote_file = sftp
        .open_mode(
            Path::new(&remote_file_path),
            OpenFlags::WRITE | OpenFlags::TRUNCATE | OpenFlags::CREATE,
            0o644,
            OpenType::File,
        )
        .map_err(|e| format!("SFTP open {}: {}", remote_file_path, e))?;

    // 512KB chunks for fast SFTP transfers
    const CHUNK_SIZE: usize = 524288;
    // Report progress every 5MB or 10 chunks to reduce IPC overhead
    const PROGRESS_INTERVAL: usize = 5242880;
    
    let mut offset = 0usize;
    let mut last_progress: u64 = 0;
    while offset < local_data.len() {
        let end = (offset + CHUNK_SIZE).min(local_data.len());
        remote_file.write_all(&local_data[offset..end]).map_err(|e| e.to_string())?;
        offset = end;
        
        // Throttle progress events: only emit if 5MB+ sent or transfer complete
        if (offset as u64 - last_progress) >= PROGRESS_INTERVAL as u64 || offset >= local_data.len() {
            last_progress = offset as u64;
            let _ = app.emit("sftp-progress", SftpProgress {
                id: transfer_id.to_string(),
                bytes_sent: offset as u64,
                total,
                done: false,
                error: None,
                remote_path: None,
                protocol: "sftp".to_string(),
            });
        }
    }

    let _ = app.emit("sftp-progress", SftpProgress {
        id: transfer_id.to_string(),
        bytes_sent: total,
        total,
        done: true,
        error: None,
        remote_path: Some(remote_file_path),
        protocol: "sftp".to_string(),
    });
    Ok(())
}

/// SCP upload (3-5x faster than SFTP for large files)
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
    use std::fs;
    let tcp = TcpStream::connect(format!("{}:{}", host, port)).map_err(|e| e.to_string())?;
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

    let local_data = fs::read(local_path).map_err(|e| e.to_string())?;
    let total = local_data.len() as u64;

    let filename = Path::new(local_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // SCP command: scp -t -r <remote_dir>
    let scp_cmd = format!("scp -t -r {}", remote_dir);
    let mut channel = sess.channel_session().map_err(|e| e.to_string())?;
    channel.exec(&scp_cmd).map_err(|e| format!("SCP exec failed: {}", e))?;

    // SCP protocol: send "C0644 <size> <filename>\n"
    let scp_header = format!("C0644 {} {}\n", total, filename);
    channel.write_all(scp_header.as_bytes()).map_err(|e| e.to_string())?;

    // Send file data in 1MB chunks (SCP has less overhead than SFTP)
    const CHUNK_SIZE: usize = 1048576;
    const PROGRESS_INTERVAL: usize = 5242880;
    
    let mut offset = 0usize;
    let mut last_progress: u64 = 0;
    while offset < local_data.len() {
        let end = (offset + CHUNK_SIZE).min(local_data.len());
        channel.write_all(&local_data[offset..end]).map_err(|e| e.to_string())?;
        offset = end;
        
        if (offset as u64 - last_progress) >= PROGRESS_INTERVAL as u64 || offset >= local_data.len() {
            last_progress = offset as u64;
            let _ = app.emit("sftp-progress", SftpProgress {
                id: transfer_id.to_string(),
                bytes_sent: offset as u64,
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
