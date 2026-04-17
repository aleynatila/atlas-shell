#![cfg_attr(
    target_os = "windows",
    windows_subsystem = "windows"
)]

use ssh2::{OpenFlags, OpenType, Session};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpStream,
    path::Path,
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
};
use once_cell::sync::Lazy;
use tauri::Manager;
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
        match TcpStream::connect(format!("{}:{}", host, port)) {
            Ok(tcp) => {
                // session creation
                if let Ok(mut sess) = Session::new() {
                    sess.set_tcp_stream(tcp);
                    if let Err(e) = sess.handshake() {
                        let _ = app.emit_all("ssh-output", SshOutput { session: session_id_clone.clone(), output: format!("handshake failed: {}", e) });
                    } else {
                        let mut authed = false;
                        if let Some(kp) = key_path.clone() {
                            let pk = Path::new(&kp);
                            let passphrase = key_passphrase.as_deref();
                            match sess.userauth_pubkey_file(&user, None, pk, passphrase) {
                                Ok(_) if sess.authenticated() => authed = true,
                                Err(e) => {
                                    let _ = app.emit_all("ssh-output", SshOutput { session: session_id_clone.clone(), output: format!("pubkey auth error: {}", e) });
                                }
                                _ => {}
                            }
                        }
                        if !authed {
                            match sess.userauth_password(&user, &pass) {
                                Ok(_) if sess.authenticated() => authed = true,
                                Err(e) => {
                                    let _ = app.emit_all("ssh-output", SshOutput { session: session_id_clone.clone(), output: format!("password auth error: {}", e) });
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
                                    sess.set_blocking(false);
                                    let mut buf = [0u8; 4096];
                                    loop {
                                        match channel.read(&mut buf) {
                                            Ok(n) if n > 0 => {
                                                let s = String::from_utf8_lossy(&buf[..n]).to_string();
                                                let _ = app.emit_all("ssh-output", SshOutput { session: session_id_clone.clone(), output: s });
                                            }
                                            _ => {}
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

                                        if channel.eof() {
                                            break;
                                        }
                                        thread::sleep(Duration::from_millis(15));
                                    }
                                }
                                Err(err) => {
                                    let _ = app.emit_all("ssh-output", SshOutput { session: session_id_clone.clone(), output: format!("channel error: {}", err) });
                                }
                            }
                        } else {
                            let _ = app.emit_all("ssh-output", SshOutput { session: session_id_clone.clone(), output: "authentication failed".into() });
                        }
                    }
                } else {
                    let _ = app.emit_all("ssh-output", SshOutput { session: session_id_clone.clone(), output: "session init failed".into() });
                }
            }
            Err(e) => {
                let _ = app.emit_all("ssh-output", SshOutput { session: session_id_clone.clone(), output: format!("tcp connect failed: {}", e) });
            }
        }

        SESS_TX.lock().unwrap().remove(&session_id_clone);
        let _ = app.emit_all("ssh-output", SshOutput { session: session_id_clone.clone(), output: "[disconnected]".into() });
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
        let result = do_sftp_upload(
            &app_handle, &transfer_id, &host, port, &user, &pass,
            key_path.as_deref(), &local_path, &remote_dir,
        );
        if let Err(e) = result {
            let _ = app_handle.emit_all("sftp-progress", SftpProgress {
                id: transfer_id,
                bytes_sent: 0,
                total: 0,
                done: true,
                error: Some(e),
                remote_path: None,
            });
        }
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

    const CHUNK_SIZE: usize = 32768;
    let mut offset = 0usize;
    while offset < local_data.len() {
        let end = (offset + CHUNK_SIZE).min(local_data.len());
        remote_file.write_all(&local_data[offset..end]).map_err(|e| e.to_string())?;
        offset = end;
        let _ = app.emit_all("sftp-progress", SftpProgress {
            id: transfer_id.to_string(),
            bytes_sent: offset as u64,
            total,
            done: false,
            error: None,
            remote_path: None,
        });
    }

    let _ = app.emit_all("sftp-progress", SftpProgress {
        id: transfer_id.to_string(),
        bytes_sent: total,
        total,
        done: true,
        error: None,
        remote_path: Some(remote_file_path),
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

fn main() {
    tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
        start_ssh_session,
        send_ssh_input,
        stop_ssh_session,
        resize_pty,
        upload_file_sftp,
        set_credential,
        get_credential,
        delete_credential,
    ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
