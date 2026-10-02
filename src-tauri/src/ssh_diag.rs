//! SSH connection diagnostics.
//!
//! When a handshake fails ("Unable to exchange encryption keys") libssh2 says nothing
//! about *why*. This module grabs the server's unencrypted KEXINIT packet (sent right
//! after the version banner, before any key exchange) and compares the algorithm lists
//! with what this build of libssh2 supports.

use serde::Serialize;
use ssh2::{MethodType, Session};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    time::Duration,
};

/// Largest SSH packet we are willing to read while looking for KEXINIT.
const MAX_PACKET: usize = 64 * 1024;
const MSG_KEXINIT: u8 = 20;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct ServerKexInit {
    pub kex: Vec<String>,
    pub host_key: Vec<String>,
    pub cipher: Vec<String>,
    pub mac: Vec<String>,
}

#[derive(Debug, Default, Clone)]
pub struct ClientAlgos {
    pub kex: Vec<String>,
    pub host_key: Vec<String>,
    pub cipher: Vec<String>,
    pub mac: Vec<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct AlgoCategory {
    pub name: String,
    pub server: Vec<String>,
    pub client: Vec<String>,
    pub common: Vec<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct SshDiagnosis {
    pub banner: String,
    pub categories: Vec<AlgoCategory>,
    /// Plain-language explanation of the first category with no overlap, if any.
    pub problem: Option<String>,
}

fn read_u32(buf: &[u8], pos: &mut usize) -> Result<u32, String> {
    let end = pos.checked_add(4).filter(|e| *e <= buf.len()).ok_or("truncated packet")?;
    let v = u32::from_be_bytes(buf[*pos..end].try_into().unwrap());
    *pos = end;
    Ok(v)
}

fn read_name_list(buf: &[u8], pos: &mut usize) -> Result<Vec<String>, String> {
    let len = read_u32(buf, pos)? as usize;
    let end = pos.checked_add(len).filter(|e| *e <= buf.len()).ok_or("truncated name-list")?;
    let text = std::str::from_utf8(&buf[*pos..end]).map_err(|_| "non-UTF-8 name-list")?;
    *pos = end;
    Ok(text.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

/// Parse the payload of an SSH_MSG_KEXINIT message (RFC 4253 §7.1).
pub fn parse_kexinit(payload: &[u8]) -> Result<ServerKexInit, String> {
    if payload.first() != Some(&MSG_KEXINIT) {
        return Err("server did not send KEXINIT first".into());
    }
    // message byte + 16-byte cookie
    let mut pos = 17;
    if payload.len() < pos {
        return Err("truncated KEXINIT".into());
    }
    let kex = read_name_list(payload, &mut pos)?;
    let host_key = read_name_list(payload, &mut pos)?;
    let cipher = read_name_list(payload, &mut pos)?; // client -> server
    let _cipher_sc = read_name_list(payload, &mut pos)?;
    let mac = read_name_list(payload, &mut pos)?; // client -> server
    Ok(ServerKexInit { kex, host_key, cipher, mac })
}

/// Extract the payload from an unencrypted SSH binary packet.
fn packet_payload(packet: &[u8]) -> Result<&[u8], String> {
    let padding = *packet.first().ok_or("empty packet")? as usize;
    let end = packet
        .len()
        .checked_sub(padding)
        .filter(|e| *e >= 1)
        .ok_or("bad padding length")?;
    Ok(&packet[1..end])
}

fn common(server: &[String], client: &[String]) -> Vec<String> {
    // Client preference order, like the real negotiation.
    client.iter().filter(|c| server.contains(c)).cloned().collect()
}

fn category(name: &str, server: &[String], client: &[String]) -> AlgoCategory {
    AlgoCategory {
        name: name.to_string(),
        server: server.to_vec(),
        client: client.to_vec(),
        common: common(server, client),
    }
}

pub fn build_diagnosis(banner: &str, server: &ServerKexInit, client: &ClientAlgos) -> SshDiagnosis {
    let categories = vec![
        category("Key exchange", &server.kex, &client.kex),
        category("Host key", &server.host_key, &client.host_key),
        category("Cipher", &server.cipher, &client.cipher),
        category("MAC", &server.mac, &client.mac),
    ];
    let problem = categories.iter().find(|c| c.common.is_empty()).map(|c| {
        format!(
            "No {} algorithm in common. The server offers: {}. Atlas supports: {}.",
            c.name.to_lowercase(),
            c.server.join(", "),
            c.client.join(", "),
        )
    });
    SshDiagnosis { banner: banner.to_string(), categories, problem }
}

fn client_algos() -> Result<ClientAlgos, String> {
    let sess = Session::new().map_err(|e| e.to_string())?;
    let get = |t| -> Vec<String> {
        sess.supported_algs(t)
            .unwrap_or_default()
            .into_iter()
            .map(str::to_string)
            .collect()
    };
    Ok(ClientAlgos {
        kex: get(MethodType::Kex),
        host_key: get(MethodType::HostKey),
        cipher: get(MethodType::CryptCs),
        mac: get(MethodType::MacCs),
    })
}

fn fetch_server_kexinit(host: &str, port: u16) -> Result<(String, ServerKexInit), String> {
    let addr = format!("{}:{}", host, port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("could not resolve host")?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(8)).map_err(|e| e.to_string())?;
    tcp.set_read_timeout(Some(Duration::from_secs(8))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(8))).ok();

    let mut writer = tcp.try_clone().map_err(|e| e.to_string())?;
    writer
        .write_all(b"SSH-2.0-AtlasDiag\r\n")
        .map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(tcp);
    // Servers may print pre-banner lines; the banner is the first line starting with "SSH-".
    let mut banner = String::new();
    for _ in 0..32 {
        let mut line = String::new();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("connection closed before the SSH banner".into());
        }
        if line.starts_with("SSH-") {
            banner = line.trim_end().to_string();
            break;
        }
    }
    if banner.is_empty() {
        return Err("no SSH banner received (is this an SSH port?)".into());
    }

    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).map_err(|e| format!("reading KEXINIT: {e}"))?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 || len > MAX_PACKET {
        return Err(format!("unexpected first packet size {len}"));
    }
    let mut packet = vec![0u8; len];
    reader.read_exact(&mut packet).map_err(|e| format!("reading KEXINIT: {e}"))?;
    let server = parse_kexinit(packet_payload(&packet)?)?;
    Ok((banner, server))
}

/// Compare the algorithms a server offers with the ones this build of Atlas supports.
#[tauri::command]
pub fn diagnose_ssh(host: String, port: u16) -> Result<SshDiagnosis, String> {
    let (banner, server) = fetch_server_kexinit(&host, port)?;
    Ok(build_diagnosis(&banner, &server, &client_algos()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name_list(items: &[&str]) -> Vec<u8> {
        let joined = items.join(",");
        let mut v = (joined.len() as u32).to_be_bytes().to_vec();
        v.extend_from_slice(joined.as_bytes());
        v
    }

    /// Build a KEXINIT payload the way an SSH server would.
    fn kexinit_payload(kex: &[&str], hk: &[&str], cipher: &[&str], mac: &[&str]) -> Vec<u8> {
        let mut p = vec![MSG_KEXINIT];
        p.extend_from_slice(&[0u8; 16]); // cookie
        for list in [kex, hk, cipher, cipher, mac, mac, &["none"], &["none"], &[], &[]] {
            p.extend(name_list(list));
        }
        p.push(0); // first_kex_packet_follows
        p.extend_from_slice(&[0, 0, 0, 0]);
        p
    }

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| i.to_string()).collect()
    }

    #[test]
    fn parses_kexinit_name_lists() {
        let payload = kexinit_payload(
            &["curve25519-sha256", "ecdh-sha2-nistp256"],
            &["ssh-ed25519", "rsa-sha2-512"],
            &["aes128-ctr"],
            &["hmac-sha2-256"],
        );
        let k = parse_kexinit(&payload).unwrap();
        assert_eq!(k.kex, s(&["curve25519-sha256", "ecdh-sha2-nistp256"]));
        assert_eq!(k.host_key, s(&["ssh-ed25519", "rsa-sha2-512"]));
        assert_eq!(k.cipher, s(&["aes128-ctr"]));
        assert_eq!(k.mac, s(&["hmac-sha2-256"]));
    }

    #[test]
    fn rejects_non_kexinit_and_truncated_data() {
        assert!(parse_kexinit(&[21, 0, 0]).is_err());
        let payload = kexinit_payload(&["a"], &["b"], &["c"], &["d"]);
        assert!(parse_kexinit(&payload[..30]).is_err());
        assert!(parse_kexinit(&[]).is_err());
    }

    #[test]
    fn strips_packet_padding() {
        let payload = kexinit_payload(&["a"], &["b"], &["c"], &["d"]);
        let mut packet = vec![4u8];
        packet.extend_from_slice(&payload);
        packet.extend_from_slice(&[0u8; 4]);
        assert_eq!(packet_payload(&packet).unwrap(), payload.as_slice());
        assert!(packet_payload(&[]).is_err());
        assert!(packet_payload(&[200, 1]).is_err());
    }

    #[test]
    fn reports_missing_kex_overlap() {
        // Modern OpenSSH vs. a build that only knows classic DH (the real failure we hit).
        let server = ServerKexInit {
            kex: s(&["curve25519-sha256", "ecdh-sha2-nistp256"]),
            host_key: s(&["ssh-ed25519", "rsa-sha2-512"]),
            cipher: s(&["aes128-ctr"]),
            mac: s(&["hmac-sha2-256"]),
        };
        let client = ClientAlgos {
            kex: s(&["diffie-hellman-group14-sha256"]),
            host_key: s(&["rsa-sha2-512"]),
            cipher: s(&["aes128-ctr"]),
            mac: s(&["hmac-sha2-256"]),
        };
        let d = build_diagnosis("SSH-2.0-OpenSSH_10.2", &server, &client);
        let msg = d.problem.expect("kex mismatch should be reported");
        assert!(msg.starts_with("No key exchange algorithm in common"));
        assert!(msg.contains("curve25519-sha256"));
        assert_eq!(d.categories[1].common, s(&["rsa-sha2-512"]));
    }

    #[test]
    fn no_problem_when_everything_overlaps() {
        let server = ServerKexInit {
            kex: s(&["a", "b"]),
            host_key: s(&["c"]),
            cipher: s(&["d"]),
            mac: s(&["e"]),
        };
        let client = ClientAlgos {
            kex: s(&["b", "a"]),
            host_key: s(&["c"]),
            cipher: s(&["d"]),
            mac: s(&["e"]),
        };
        let d = build_diagnosis("SSH-2.0-x", &server, &client);
        assert!(d.problem.is_none());
        // Client preference order wins.
        assert_eq!(d.categories[0].common, s(&["b", "a"]));
    }

    /// Live check against a real server: `ATLAS_DIAG_HOST=10.0.0.5 cargo test live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_server() {
        let host = std::env::var("ATLAS_DIAG_HOST").expect("set ATLAS_DIAG_HOST");
        let d = diagnose_ssh(host, 22).unwrap();
        println!("banner: {}", d.banner);
        for c in &d.categories {
            println!("{}: common={:?}", c.name, c.common);
        }
        println!("problem: {:?}", d.problem);
        assert!(d.banner.starts_with("SSH-2.0"));
        assert!(d.categories.iter().all(|c| !c.server.is_empty()));
    }
}
