//! Read and write small remote text files over SFTP (used by the Files editor).

use super::{ssh_authenticate, widen_algo_prefs};
use serde::Serialize;
use ssh2::{FileStat, RenameFlags, Session, Sftp};
use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::Path,
    time::Duration,
};
use zeroize::Zeroizing;

/// Files larger than this are not opened in the editor.
pub const MAX_EDIT_BYTES: u64 = 512 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct RemoteFileContent {
    pub content: String,
    pub size: u64,
}

/// Decode file bytes for the editor, refusing binary data and oversized files.
pub fn decode_text(bytes: &[u8], limit: u64) -> Result<String, String> {
    if bytes.len() as u64 > limit {
        return Err(format!("File is too large to edit (limit {} KB)", limit / 1024));
    }
    if bytes.contains(&0) {
        return Err("Binary file - can't be edited as text".into());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "File is not valid UTF-8 text".to_string())
}

fn open_sftp(
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
    key_path: Option<&str>,
) -> Result<(Session, Sftp), String> {
    let addr = format!("{}:{}", host, port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("Could not resolve host")?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(8)).map_err(|e| e.to_string())?;
    let mut sess = Session::new().map_err(|e| e.to_string())?;
    sess.set_timeout(15_000);
    sess.set_tcp_stream(tcp);
    widen_algo_prefs(&sess);
    sess.handshake().map_err(|e| e.to_string())?;
    let pass = Zeroizing::new(pass.to_string());
    ssh_authenticate(&mut sess, user, &pass, key_path)?;
    let sftp = sess.sftp().map_err(|e| format!("SFTP init failed: {}", e))?;
    Ok((sess, sftp))
}

fn read_file(sftp: &Sftp, path: &str) -> Result<RemoteFileContent, String> {
    let stat = sftp.stat(Path::new(path)).map_err(|e| format!("stat failed: {}", e))?;
    if stat.is_dir() {
        return Err("This is a folder".into());
    }
    let size = stat.size.unwrap_or(0);
    if size > MAX_EDIT_BYTES {
        return Err(format!("File is too large to edit (limit {} KB)", MAX_EDIT_BYTES / 1024));
    }
    let mut file = sftp.open(Path::new(path)).map_err(|e| format!("open failed: {}", e))?;
    // Read at most limit+1 bytes so a file that grew since stat() is still caught.
    let mut buf = Vec::new();
    (&mut file)
        .take(MAX_EDIT_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("read failed: {}", e))?;
    let content = decode_text(&buf, MAX_EDIT_BYTES)?;
    Ok(RemoteFileContent { content, size: buf.len() as u64 })
}

fn write_file(sftp: &Sftp, path: &str, content: &str) -> Result<(), String> {
    let target = Path::new(path);
    // Keep the original permissions; a missing file simply gets the server default.
    let perm = sftp.stat(target).ok().and_then(|s| s.perm);
    let tmp = format!("{}.atlas-tmp-{}", path, std::process::id());
    let tmp_path = Path::new(&tmp);

    let mut keep_tmp = false;
    let result = (|| -> Result<(), String> {
        let mut f = sftp.create(tmp_path).map_err(|e| format!("can't create temp file: {}", e))?;
        f.write_all(content.as_bytes()).map_err(|e| format!("write failed: {}", e))?;
        f.flush().ok();
        drop(f);
        if perm.is_some() {
            let stat = FileStat { size: None, uid: None, gid: None, perm, atime: None, mtime: None };
            let _ = sftp.setstat(tmp_path, stat);
        }
        // Atomic replace where the server supports it. OpenSSH's SFTP server (protocol v3)
        // refuses to rename onto an existing file, so fall back to unlink + rename; the
        // new content is already fully written to the temp file at this point.
        if sftp
            .rename(
                tmp_path,
                target,
                Some(RenameFlags::OVERWRITE | RenameFlags::ATOMIC | RenameFlags::NATIVE),
            )
            .is_ok()
        {
            return Ok(());
        }
        sftp.unlink(target).map_err(|e| format!("can't replace file: {}", e))?;
        sftp.rename(tmp_path, target, None).map_err(|e| {
            keep_tmp = true;
            format!("rename failed ({e}); your edit is saved as {tmp}")
        })
    })();
    if result.is_err() && !keep_tmp {
        let _ = sftp.unlink(tmp_path);
    }
    result
}

#[tauri::command(async)]
pub fn read_remote_file(
    host: String,
    port: u16,
    user: String,
    pass: String,
    key_path: Option<String>,
    path: String,
) -> Result<RemoteFileContent, String> {
    let (_sess, sftp) = open_sftp(&host, port, &user, &pass, key_path.as_deref())?;
    read_file(&sftp, &path)
}

#[tauri::command(async)]
pub fn write_remote_file(
    host: String,
    port: u16,
    user: String,
    pass: String,
    key_path: Option<String>,
    path: String,
    content: String,
) -> Result<(), String> {
    let (_sess, sftp) = open_sftp(&host, port, &user, &pass, key_path.as_deref())?;
    write_file(&sftp, &path, &content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_plain_and_unicode_text() {
        assert_eq!(decode_text(b"hello\n", 100).unwrap(), "hello\n");
        assert_eq!(decode_text("merhaba dünya ✓".as_bytes(), 100).unwrap(), "merhaba dünya ✓");
        assert_eq!(decode_text(b"", 100).unwrap(), "");
    }

    #[test]
    fn refuses_binary_invalid_utf8_and_oversized() {
        assert!(decode_text(b"abc\0def", 100).unwrap_err().contains("Binary"));
        assert!(decode_text(&[0xff, 0xfe, 0x41], 100).unwrap_err().contains("UTF-8"));
        assert!(decode_text(&[b'a'; 2048], 1024).unwrap_err().contains("too large"));
        assert!(decode_text(&[b'a'; 1024], 1024).is_ok());
    }

    /// Live round-trip against a real SSH server (see README of the test setup):
    /// `ATLAS_TEST_HOST=127.0.0.1 ATLAS_TEST_PORT=2222 ATLAS_TEST_USER=tester ATLAS_TEST_PASS=testpass     ///  cargo test live_roundtrip -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_roundtrip() {
        let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("set {k}"));
        let host = env("ATLAS_TEST_HOST");
        let port: u16 = env("ATLAS_TEST_PORT").parse().unwrap();
        let user = env("ATLAS_TEST_USER");
        let pass = env("ATLAS_TEST_PASS");
        let dir = format!("/config/atlas-test-{}", std::process::id());

        let diag = crate::ssh_diag::diagnose_ssh(host.clone(), port).unwrap();
        assert!(diag.banner.starts_with("SSH-2.0"), "banner: {}", diag.banner);
        assert!(diag.problem.is_none(), "diagnosis: {:?}", diag.problem);

        let (_sess, sftp) = open_sftp(&host, port, &user, &pass, None).unwrap();
        sftp.mkdir(Path::new(&dir), 0o755).unwrap();
        let file = format!("{dir}/notes.txt");

        // Write a new file, read it back.
        write_file(&sftp, &file, "line one
merhaba dünya ✓
").unwrap();
        let got = read_file(&sftp, &file).unwrap();
        assert_eq!(got.content, "line one
merhaba dünya ✓
");

        // Overwrite keeps the permissions and leaves no temp file behind.
        sftp.setstat(
            Path::new(&file),
            FileStat { size: None, uid: None, gid: None, perm: Some(0o640), atime: None, mtime: None },
        )
        .unwrap();
        write_file(&sftp, &file, "second version").unwrap();
        assert_eq!(read_file(&sftp, &file).unwrap().content, "second version");
        let perm = sftp.stat(Path::new(&file)).unwrap().perm.unwrap() & 0o777;
        assert_eq!(perm, 0o640, "permissions must survive an edit");
        let names: Vec<String> = sftp
            .readdir(Path::new(&dir))
            .unwrap()
            .into_iter()
            .map(|(p, _)| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["notes.txt".to_string()], "temp file left behind");

        // Guards: folder, binary, oversized, missing.
        assert!(read_file(&sftp, &dir).unwrap_err().contains("folder"));
        let bin = format!("{dir}/blob.bin");
        sftp.create(Path::new(&bin)).unwrap().write_all(&[1, 2, 0, 3]).unwrap();
        assert!(read_file(&sftp, &bin).unwrap_err().contains("Binary"));
        let big = format!("{dir}/big.txt");
        sftp.create(Path::new(&big))
            .unwrap()
            .write_all(&vec![b'a'; MAX_EDIT_BYTES as usize + 10])
            .unwrap();
        assert!(read_file(&sftp, &big).unwrap_err().contains("too large"));
        assert!(read_file(&sftp, &format!("{dir}/missing")).is_err());

        // Writing into a non-existent directory fails cleanly.
        assert!(write_file(&sftp, "/config/no-such-dir/x.txt", "x").is_err());

        for f in ["notes.txt", "blob.bin", "big.txt"] {
            sftp.unlink(Path::new(&format!("{dir}/{f}"))).unwrap();
        }
        sftp.rmdir(Path::new(&dir)).unwrap();
    }

    /// Same live server: directory listing used by the Files modal (folders first, sorted).
    #[test]
    #[ignore]
    fn live_listing() {
        let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("set {k}"));
        let (host, user, pass) = (env("ATLAS_TEST_HOST"), env("ATLAS_TEST_USER"), env("ATLAS_TEST_PASS"));
        let port: u16 = env("ATLAS_TEST_PORT").parse().unwrap();
        let dir = format!("/config/atlas-list-{}", std::process::id());
        let (_sess, sftp) = open_sftp(&host, port, &user, &pass, None).unwrap();
        sftp.mkdir(Path::new(&dir), 0o755).unwrap();
        sftp.mkdir(Path::new(&format!("{dir}/Zeta")), 0o755).unwrap();
        sftp.mkdir(Path::new(&format!("{dir}/alpha")), 0o755).unwrap();
        for f in ["b.txt", "A.txt"] {
            sftp.create(Path::new(&format!("{dir}/{f}"))).unwrap().write_all(b"x").unwrap();
        }

        let listing = crate::list_remote_dir(host, port, user, pass, None, Some(dir.clone())).unwrap();
        assert_eq!(listing.path, dir);
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "Zeta", "A.txt", "b.txt"]);

        for f in ["b.txt", "A.txt"] {
            sftp.unlink(Path::new(&format!("{dir}/{f}"))).unwrap();
        }
        for d in ["Zeta", "alpha"] {
            sftp.rmdir(Path::new(&format!("{dir}/{d}"))).unwrap();
        }
        sftp.rmdir(Path::new(&dir)).unwrap();
    }
}
