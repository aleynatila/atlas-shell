#![cfg_attr(
    target_os = "windows",
    windows_subsystem = "windows"
)]

mod cred_store;
mod remote_file;
mod ssh_diag;

use ssh2::{MethodType, Session};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
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

/// Widen key-exchange/host-key negotiation beyond libssh2's defaults so we can still
/// reach old network gear and ancient OpenSSH builds that only speak legacy algorithms
/// (the same failure PuTTY works around via its Kex/Host keys panel). Modern algorithms
/// are listed first so up-to-date servers keep negotiating strong crypto; unsupported
/// names are silently ignored by libssh2. Must run before `handshake()`.
fn widen_algo_prefs(sess: &Session) {
    const HOST_KEY: &[&str] = &[
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "rsa-sha2-512",
        "rsa-sha2-256",
        "ssh-rsa",
    ];
    // KEX: every algorithm this libssh2 build supports (incl. legacy DH groups), in
    // libssh2's own order. Reordering it breaks negotiation with modern OpenSSH
    // ("Unable to exchange encryption keys"), so keep the order as reported.
    if let Ok(kex) = sess.supported_algs(MethodType::Kex) {
        if !kex.is_empty() {
            let _ = sess.method_pref(MethodType::Kex, &kex.join(","));
        }
    }
    // Host keys: preferred order first, then anything else supported, so the list
    // is never narrower than libssh2's defaults.
    let supported = sess.supported_algs(MethodType::HostKey).unwrap_or_default();
    let mut list: Vec<&str> = HOST_KEY
        .iter()
        .copied()
        .filter(|a| supported.contains(a))
        .collect();
    for a in supported {
        if !list.contains(&a) {
            list.push(a);
        }
    }
    if !list.is_empty() {
        let _ = sess.method_pref(MethodType::HostKey, &list.join(","));
    }
}

/// Whether the last `ESC[?{mode}h` / `ESC[?{mode}l` in `s` turned the DEC
/// private mode on; `None` if `s` doesn't mention it.
fn dec_mode_last(s: &str, mode: &str) -> Option<bool> {
    let on = s.rfind(&format!("\x1b[?{mode}h"));
    let off = s.rfind(&format!("\x1b[?{mode}l"));
    if on.is_none() && off.is_none() { None } else { Some(on > off) }
}

/// Whether the tail of the output looks like a shell waiting at its prompt.
/// bash ≥ 5.1 and zsh turn bracketed paste on while their line editor reads a
/// line and off once it's submitted; older bash is recognised by a prompt line
/// ending in `$ `, `# ` or `% `. A login banner that paused mid-way, a password
/// prompt or a running command matches neither.
fn at_shell_prompt(tail: &str) -> bool {
    if let Some(on) = dec_mode_last(tail, "2004") {
        return on;
    }
    let line = tail.rsplit(['\n', '\r']).next().unwrap_or("");
    let mut visible = String::new();
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            if !c.is_control() {
                visible.push(c);
            }
            continue;
        }
        match chars.next() {
            // CSI: parameters up to a final byte in @..~
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC (window title etc.): up to BEL or ESC \
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    let trimmed = visible.trim_end();
    trimmed.len() < visible.len() && trimmed.ends_with(['$', '#', '%'])
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
                // Interactive session: send keystrokes immediately instead of letting
                // Nagle hold small packets back (OpenSSH does the same).
                let _ = tcp.set_nodelay(true);
                // session creation
                if let Ok(mut sess) = Session::new() {
                    // 15s timeout for all blocking SSH operations (handshake, auth, etc.)
                    sess.set_timeout(15_000);
                    sess.set_tcp_stream(tcp);
                    widen_algo_prefs(&sess);
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
                                    // One-time cwd hook (OSC 7) so the file browser can open where the
                                    // user `cd`'d to. 0 = waiting for the first prompt, 1 = sent and
                                    // hiding its echo, 2 = done. Sent only once the output has gone
                                    // quiet at something that looks like a shell prompt (see
                                    // at_shell_prompt) — typing it during a paused login banner or
                                    // into a running program left it visible on screen. Its echo is
                                    // held back until the first OSC 7 arrives (or a timeout, so
                                    // non-bash/zsh shells still show what happened).
                                    let mut hook_state: u8 = 0;
                                    let hook_started = std::time::Instant::now();
                                    let mut hook_last_data: Option<std::time::Instant> = None;
                                    let mut hook_sent_at = std::time::Instant::now();
                                    let mut hook_held = String::new();
                                    // Last ~1 KB of output while waiting, for the prompt check.
                                    let mut hook_tail = String::new();
                                    // vim, less, htop… run on the alternate screen; never type
                                    // the hook into them.
                                    let mut alt_screen = false;
                                    // True while the user has typed into the prompt without
                                    // submitting it. The hook must not be sent then: it would be
                                    // appended to their half-typed command (`cd /x __atlas_cwd(){…`)
                                    // and fail with a bash syntax error.
                                    let mut line_dirty = false;
                                    // Input that woke the idle wait below; handled at the top of the
                                    // next drain.
                                    let mut woken_by: Option<InputMessage> = None;
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
                                        if hook_state == 1 {
                                            hook_held.push_str(&combined);
                                            combined.clear();
                                            if let Some(i) = hook_held.find("\x1b]7;") {
                                                // Drop the hook's echo; clear the row so the next
                                                // prompt replaces the one the echo was typed after.
                                                let rest = hook_held.split_off(i);
                                                hook_held.clear();
                                                combined = format!("\r\x1b[2K{rest}");
                                                hook_state = 2;
                                            } else if hook_sent_at.elapsed().as_secs() >= 4 {
                                                combined = std::mem::take(&mut hook_held);
                                                hook_state = 2;
                                            }
                                        }
                                        if hook_state == 0 && !combined.is_empty() {
                                            hook_tail.push_str(&combined);
                                            if hook_tail.len() > 1024 {
                                                let mut cut = hook_tail.len() - 1024;
                                                while !hook_tail.is_char_boundary(cut) {
                                                    cut += 1;
                                                }
                                                hook_tail.drain(..cut);
                                            }
                                            if let Some(on) = dec_mode_last(&hook_tail, "1049") {
                                                alt_screen = on;
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
                                            let next = match woken_by.take() {
                                                Some(msg) => Ok(msg),
                                                None => rx.try_recv(),
                                            };
                                            match next {
                                                Ok(InputMessage::Data(d)) => {
                                                    got_input = true;
                                                    if hook_state == 0 && !d.is_empty() {
                                                        // Enter, Ctrl-C and Ctrl-U leave an empty line;
                                                        // anything typed after the last one doesn't.
                                                        line_dirty = match d.iter().rposition(|&b| matches!(b, b'\r' | b'\n' | 0x03 | 0x15)) {
                                                            Some(i) => i + 1 < d.len(),
                                                            None => true,
                                                        };
                                                    }
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
                                        if hook_state == 0 {
                                            // Input counts too, so after Enter we wait for the
                                            // command's output to settle instead of firing at once.
                                            if got_data || got_input {
                                                hook_last_data = Some(std::time::Instant::now());
                                            }
                                            let quiet = hook_last_data
                                                .map_or(false, |t| t.elapsed().as_millis() >= 250);
                                            if hook_started.elapsed().as_secs() >= 15 {
                                                // No prompt recognised in time (odd prompt, or the
                                                // user is already in a REPL): skip the hook rather
                                                // than risk typing it into something else.
                                                hook_state = 2;
                                                hook_tail = String::new();
                                            } else if !line_dirty && quiet && !alt_screen && at_shell_prompt(&hook_tail) {
                                                // Leading space keeps it out of history; shells other
                                                // than bash/zsh just ignore it.
                                                let _ = channel.write_all(
                                                    concat!(
                                                        " __atlas_cwd(){ printf '\\033]7;file://%s%s\\007' \"$HOSTNAME\" \"$PWD\"; }; ",
                                                        "[ -n \"$BASH_VERSION\" ] && PROMPT_COMMAND=\"__atlas_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"; ",
                                                        "[ -n \"$ZSH_VERSION\" ] && precmd_functions+=(__atlas_cwd); ",
                                                        "__atlas_cwd
"
                                                    )
                                                    .as_bytes(),
                                                );
                                                hook_state = 1;
                                                hook_sent_at = std::time::Instant::now();
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
                                            // Wait on the input channel instead of sleeping so a
                                            // keypress after a long idle is sent at once (a plain
                                            // sleep added up to 100 ms to the first keystroke).
                                            // Timeout/disconnect fall through; the drain above
                                            // detects a closed channel on the next turn.
                                            if let Ok(msg) = rx.recv_timeout(Duration::from_millis(sleep_ms)) {
                                                woken_by = Some(msg);
                                            }
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
    direction: String,
    local_path: Option<String>,
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
    if Path::new(&local_path).is_dir() {
        return Err("Folders can't be uploaded yet - drop individual files".into());
    }
    // Emit immediately so the UI registers the transfer before the thread even starts
    let _ = app_handle.emit("SCP-progress", SCPProgress {
        id: transfer_id.clone(),
        bytes_sent: 0,
        total: 0,
        done: false,
        error: None,
        remote_path: None,
        protocol: "scp".to_string(),
        direction: "upload".to_string(),
        local_path: None,
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
                direction: "upload".to_string(),
                local_path: None,
            });
        }
    });
    Ok(())
}

/// Opens a TCP socket tuned for bulk file transfer: 4 MB send buffer keeps the
/// kernel pipeline full ahead of the SSH encryption cycle; nodelay kills Nagle latency.
fn tuned_tcp_connect(host: &str, port: u16) -> Result<TcpStream, String> {
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
    Ok(raw.into())
}

/// Auth chain shared by SCP/SFTP helper commands: pubkey (if a key path was given),
/// then plain password, then keyboard-interactive (PAM / ChallengeResponseAuthentication).
fn ssh_authenticate(sess: &mut Session, user: &str, pass: &str, key_path: Option<&str>) -> Result<(), String> {
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
            let mut kbd = PasswordKbdAuth(pass.to_string());
            if sess.userauth_keyboard_interactive(user, &mut kbd).is_ok() && sess.authenticated() {
                authed = true;
            }
        }
    }
    if authed {
        Ok(())
    } else {
        Err("authentication failed".into())
    }
}

/// Resolves a leading "~" in a remote directory to an absolute path via SFTP's
/// realpath (which the SFTP subsystem resolves relative to the login's home
/// directory). Neither `mkdir -p '<dir>'` (single-quoted, so no shell
/// expansion) nor scp_send's path (sent raw over the SCP protocol, never
/// touching a shell) expand "~" themselves — left as-is, a literal "~" ends
/// up as a directory/file named "~" instead of landing in the home dir.
fn resolve_remote_home(sess: &Session, dir: &str) -> String {
    if dir != "~" && !dir.starts_with("~/") {
        return dir.to_string();
    }
    let Ok(sftp) = sess.sftp() else { return dir.to_string() };
    let Ok(home) = sftp.realpath(Path::new(".")) else { return dir.to_string() };
    let home = home.to_string_lossy().to_string();
    if dir == "~" {
        home
    } else {
        format!("{}/{}", home.trim_end_matches('/'), &dir[2..])
    }
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
    let tcp = tuned_tcp_connect(host, port)?;

    let mut sess = Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    widen_algo_prefs(&sess);
    sess.handshake().map_err(|e| e.to_string())?;
    ssh_authenticate(&mut sess, user, pass, key_path).map_err(|_| "SCP authentication failed".to_string())?;

    // Neither `mkdir -p '<dir>'` (quoted, so the shell won't expand it) nor
    // scp_send's path (sent raw over the SCP protocol, never touches a shell)
    // expand a leading "~" — passing it through literally used to create a
    // directory/file literally named "~" instead of landing in the home dir.
    let remote_dir = resolve_remote_home(&sess, remote_dir);

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
        direction: "upload".to_string(),
        local_path: None,
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
                    direction: "upload".to_string(),
                    local_path: None,
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
        direction: "upload".to_string(),
        local_path: None,
    });
    Ok(())
}


#[derive(Serialize, Clone)]
struct RemoteEntry {
    name: String,
    is_dir: bool,
    is_symlink: bool,
    size: u64,
    mtime: i64,
}

#[derive(Serialize, Clone)]
struct RemoteListing {
    path: String,
    entries: Vec<RemoteEntry>,
}

/// List a remote directory over SFTP. Listing has no SCP equivalent (the SCP
/// protocol has no directory-enumeration command), so this opens the SFTP
/// subsystem on a fresh connection; the actual file transfer in
/// `download_file_scp` below still goes over plain SCP.
#[tauri::command(async)]
fn list_remote_dir(
    host: String,
    port: u16,
    user: String,
    pass: String,
    key_path: Option<String>,
    path: Option<String>,
) -> Result<RemoteListing, String> {
    let addr: SocketAddr = format!("{}:{}", host, port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("Could not resolve host")?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(8)).map_err(|e| e.to_string())?;

    let mut sess = Session::new().map_err(|e| e.to_string())?;
    sess.set_timeout(8_000);
    sess.set_tcp_stream(tcp);
    widen_algo_prefs(&sess);
    sess.handshake().map_err(|e| e.to_string())?;
    let pass = Zeroizing::new(pass);
    ssh_authenticate(&mut sess, &user, &*pass, key_path.as_deref())?;

    let sftp = sess.sftp().map_err(|e| format!("SFTP init failed: {}", e))?;

    let target = match path.filter(|p| !p.is_empty()) {
        Some(p) => p,
        None => sftp
            .realpath(Path::new("."))
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string()),
    };

    let raw = sftp
        .readdir(Path::new(&target))
        .map_err(|e| format!("listing failed: {}", e))?;

    let mut entries: Vec<RemoteEntry> = raw
        .into_iter()
        .filter_map(|(full_path, stat)| {
            let name = full_path.file_name()?.to_string_lossy().to_string();
            let is_symlink = stat.perm.map(|p| p & 0o170000 == 0o120000).unwrap_or(false);
            Some(RemoteEntry {
                name,
                is_dir: stat.is_dir(),
                is_symlink,
                size: stat.size.unwrap_or(0),
                mtime: stat.mtime.unwrap_or(0) as i64,
            })
        })
        .collect();

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(RemoteListing { path: target, entries })
}

/// Native "choose a destination folder" dialog for SCP downloads.
#[tauri::command]
fn pick_download_folder() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn download_file_scp(
    app_handle: tauri::AppHandle,
    transfer_id: String,
    host: String,
    port: u16,
    user: String,
    pass: String,
    key_path: Option<String>,
    remote_path: String,
    local_dir: String,
) -> Result<(), String> {
    let _ = app_handle.emit("SCP-progress", SCPProgress {
        id: transfer_id.clone(),
        bytes_sent: 0,
        total: 0,
        done: false,
        error: None,
        remote_path: Some(remote_path.clone()),
        protocol: "scp".to_string(),
        direction: "download".to_string(),
        local_path: None,
    });
    thread::spawn(move || {
        let pass = Zeroizing::new(pass);
        let result = do_scp_download(
            &app_handle, &transfer_id, &host, port, &user, &*pass,
            key_path.as_deref(), &remote_path, &local_dir,
        );
        if let Err(e) = result {
            let _ = app_handle.emit("SCP-progress", SCPProgress {
                id: transfer_id,
                bytes_sent: 0,
                total: 0,
                done: true,
                error: Some(e),
                remote_path: Some(remote_path),
                protocol: "error".to_string(),
                direction: "download".to_string(),
                local_path: None,
            });
        }
    });
    Ok(())
}

/// SCP download — mirrors `do_scp_upload` but pulls a remote file down to `local_dir`
/// via libssh2's native `scp_recv`, which handles the SCP protocol handshake internally.
fn do_scp_download(
    app: &tauri::AppHandle,
    transfer_id: &str,
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
    key_path: Option<&str>,
    remote_path: &str,
    local_dir: &str,
) -> Result<(), String> {
    let tcp = tuned_tcp_connect(host, port)?;

    let mut sess = Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    widen_algo_prefs(&sess);
    sess.handshake().map_err(|e| e.to_string())?;
    ssh_authenticate(&mut sess, user, pass, key_path).map_err(|_| "SCP authentication failed".to_string())?;

    use std::fs::File;

    let (mut channel, stat) = sess
        .scp_recv(Path::new(remote_path))
        .map_err(|e| format!("SCP open failed: {}", e))?;
    let total = stat.size();

    let filename = Path::new(remote_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    fs::create_dir_all(local_dir).map_err(|e| e.to_string())?;
    let local_path = Path::new(local_dir).join(&filename);

    let _ = app.emit("SCP-progress", SCPProgress {
        id: transfer_id.to_string(),
        bytes_sent: 0,
        total,
        done: false,
        error: None,
        remote_path: Some(remote_path.to_string()),
        protocol: "scp".to_string(),
        direction: "download".to_string(),
        local_path: Some(local_path.to_string_lossy().to_string()),
    });

    // 128 KB read chunks, matching the write chunk size used for uploads.
    const READ_CHUNK: usize = 131_072;
    const PROGRESS_INTERVAL: u64 = 524_288; // emit every 512 KB

    let mut file = File::create(&local_path).map_err(|e| e.to_string())?;
    let mut buf = [0u8; READ_CHUNK];
    let mut received: u64 = 0;
    let mut last_progress: u64 = 0;

    // scp_recv's channel is internally limited to `total` bytes (libssh2 sets
    // the read limit from the C0644 header), so a plain read-until-EOF loop
    // never runs past the file into trailing SCP protocol bytes.
    loop {
        let n = channel.read(&mut buf).map_err(|e| format!("SCP read error: {}", e))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;

        if received - last_progress >= PROGRESS_INTERVAL || received >= total {
            last_progress = received;
            let _ = app.emit("SCP-progress", SCPProgress {
                id: transfer_id.to_string(),
                bytes_sent: received,
                total,
                done: false,
                error: None,
                remote_path: Some(remote_path.to_string()),
                protocol: "scp".to_string(),
                direction: "download".to_string(),
                local_path: Some(local_path.to_string_lossy().to_string()),
            });
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    channel.send_eof().ok();
    channel.wait_eof().ok();
    channel.close().ok();
    channel.wait_close().ok();

    let _ = app.emit("SCP-progress", SCPProgress {
        id: transfer_id.to_string(),
        bytes_sent: total,
        total,
        done: true,
        error: None,
        remote_path: Some(remote_path.to_string()),
        protocol: "scp".to_string(),
        direction: "download".to_string(),
        local_path: Some(local_path.to_string_lossy().to_string()),
    });
    Ok(())
}

#[tauri::command]
fn download_folder_scp(
    app_handle: tauri::AppHandle,
    transfer_id: String,
    host: String,
    port: u16,
    user: String,
    pass: String,
    key_path: Option<String>,
    remote_path: String,
    local_dir: String,
) -> Result<(), String> {
    let _ = app_handle.emit("SCP-progress", SCPProgress {
        id: transfer_id.clone(),
        bytes_sent: 0,
        total: 0,
        done: false,
        error: None,
        remote_path: Some(remote_path.clone()),
        protocol: "scp".to_string(),
        direction: "download".to_string(),
        local_path: None,
    });
    thread::spawn(move || {
        let pass = Zeroizing::new(pass);
        let result = do_scp_download_folder(
            &app_handle, &transfer_id, &host, port, &user, &*pass,
            key_path.as_deref(), &remote_path, &local_dir,
        );
        if let Err(e) = result {
            let _ = app_handle.emit("SCP-progress", SCPProgress {
                id: transfer_id,
                bytes_sent: 0,
                total: 0,
                done: true,
                error: Some(e),
                remote_path: Some(remote_path),
                protocol: "error".to_string(),
                direction: "download".to_string(),
                local_path: None,
            });
        }
    });
    Ok(())
}

struct RemoteFolderFile {
    remote: String,
    relative: PathBuf,
    size: u64,
}

/// Recursively walks a remote directory over SFTP, collecting every regular file
/// (with its path relative to `remote_dir`) and every subdirectory. Symlinked
/// directories are listed but not descended into, to avoid symlink-loop recursion.
fn walk_remote_dir(
    sftp: &ssh2::Sftp,
    remote_dir: &str,
    rel_prefix: &Path,
    depth: u32,
    files: &mut Vec<RemoteFolderFile>,
    dirs: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > 40 {
        return Ok(());
    }
    let entries = sftp
        .readdir(Path::new(remote_dir))
        .map_err(|e| format!("listing failed for {}: {}", remote_dir, e))?;
    for (full_path, stat) in entries {
        let Some(name) = full_path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let is_symlink = stat.perm.map(|p| p & 0o170000 == 0o120000).unwrap_or(false);
        let rel = rel_prefix.join(&name);
        let child_remote = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
        if stat.is_dir() {
            dirs.push(rel.clone());
            if !is_symlink {
                walk_remote_dir(sftp, &child_remote, &rel, depth + 1, files, dirs)?;
            }
        } else if stat.is_file() {
            files.push(RemoteFolderFile {
                remote: child_remote,
                relative: rel,
                size: stat.size.unwrap_or(0),
            });
        }
    }
    Ok(())
}

/// Recursive SCP folder download: SFTP is used only to discover the tree
/// (mirrors the read-only rationale in `list_remote_dir`); every file's bytes
/// are still pulled over plain SCP via `scp_recv`, one channel per file on the
/// same authenticated connection.
fn do_scp_download_folder(
    app: &tauri::AppHandle,
    transfer_id: &str,
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
    key_path: Option<&str>,
    remote_path: &str,
    local_dir: &str,
) -> Result<(), String> {
    let tcp = tuned_tcp_connect(host, port)?;
    let mut sess = Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    widen_algo_prefs(&sess);
    sess.handshake().map_err(|e| e.to_string())?;
    ssh_authenticate(&mut sess, user, pass, key_path).map_err(|_| "SCP authentication failed".to_string())?;

    let sftp = sess.sftp().map_err(|e| format!("SFTP init failed: {}", e))?;

    let folder_name = Path::new(remote_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let local_root = Path::new(local_dir).join(&folder_name);

    let mut files = Vec::new();
    let mut dirs = Vec::new();
    walk_remote_dir(&sftp, remote_path, Path::new(""), 0, &mut files, &mut dirs)?;

    fs::create_dir_all(&local_root).map_err(|e| e.to_string())?;
    for d in &dirs {
        fs::create_dir_all(local_root.join(d)).map_err(|e| e.to_string())?;
    }

    let total: u64 = files.iter().map(|f| f.size).sum();
    let mut sent: u64 = 0;
    let mut last_progress: u64 = 0;

    let _ = app.emit("SCP-progress", SCPProgress {
        id: transfer_id.to_string(),
        bytes_sent: 0,
        total,
        done: false,
        error: None,
        remote_path: Some(remote_path.to_string()),
        protocol: "scp".to_string(),
        direction: "download".to_string(),
        local_path: Some(local_root.to_string_lossy().to_string()),
    });

    use std::fs::File;
    const READ_CHUNK: usize = 131_072;
    const PROGRESS_INTERVAL: u64 = 524_288;
    let mut buf = [0u8; READ_CHUNK];

    for f in &files {
        let local_path = local_root.join(&f.relative);
        if let Some(parent) = local_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let (mut channel, _stat) = sess
            .scp_recv(Path::new(&f.remote))
            .map_err(|e| format!("SCP open failed for {}: {}", f.remote, e))?;
        let mut file = File::create(&local_path).map_err(|e| e.to_string())?;
        loop {
            let n = channel.read(&mut buf).map_err(|e| format!("SCP read error: {}", e))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            sent += n as u64;

            if sent - last_progress >= PROGRESS_INTERVAL || sent >= total {
                last_progress = sent;
                let _ = app.emit("SCP-progress", SCPProgress {
                    id: transfer_id.to_string(),
                    bytes_sent: sent,
                    total,
                    done: false,
                    error: None,
                    remote_path: Some(remote_path.to_string()),
                    protocol: "scp".to_string(),
                    direction: "download".to_string(),
                    local_path: Some(local_root.to_string_lossy().to_string()),
                });
            }
        }
        file.flush().map_err(|e| e.to_string())?;
        channel.send_eof().ok();
        channel.wait_eof().ok();
        channel.close().ok();
        channel.wait_close().ok();
    }

    let _ = app.emit("SCP-progress", SCPProgress {
        id: transfer_id.to_string(),
        bytes_sent: total,
        total,
        done: true,
        error: None,
        remote_path: Some(remote_path.to_string()),
        protocol: "scp".to_string(),
        direction: "download".to_string(),
        local_path: Some(local_root.to_string_lossy().to_string()),
    });
    Ok(())
}

/// Saved passwords live in an encrypted file on macOS (see cred_store) and in
/// the OS keychain elsewhere (Windows Credential Manager / SecretService).
fn cred_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app_handle.path().app_data_dir().map_err(|e| e.to_string())
}

/// Store a saved password.
#[tauri::command(async)]
fn set_credential(app_handle: tauri::AppHandle, id: String, password: String) -> Result<(), String> {
    let password = Zeroizing::new(password);
    if cfg!(target_os = "macos") {
        return cred_store::set(&cred_dir(&app_handle)?, &id, &password);
    }
    Entry::new("atlas", &id)
        .map_err(|e| e.to_string())?
        .set_password(&*password)
        .map_err(|e| e.to_string())
}

/// Retrieve a saved password. Returns None if not found.
#[tauri::command(async)]
fn get_credential(app_handle: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    if cfg!(target_os = "macos") {
        return cred_store::get(&cred_dir(&app_handle)?, &id);
    }
    let entry = Entry::new("atlas", &id).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a saved password. Silently succeeds if not found.
#[tauri::command(async)]
fn delete_credential(app_handle: tauri::AppHandle, id: String) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        return cred_store::delete(&cred_dir(&app_handle)?, &id);
    }
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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
        resize_pty,
        upload_file_scp,
        list_remote_dir,
        pick_download_folder,
        download_file_scp,
        download_folder_scp,
        set_credential,
        get_credential,
        delete_credential,
        read_store,
        write_store,
        debug_log,
        export_to_file,
        import_from_file,
        ssh_diag::diagnose_ssh,
        remote_file::read_remote_file,
        remote_file::write_remote_file,
    ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
