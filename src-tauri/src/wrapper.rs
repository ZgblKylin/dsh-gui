//! Loopback static server for the shell's wrapper page.
//!
//! The wrapper page is normally served from the `tauri://` app origin, which
//! makes its harness iframe a cross-site frame: browser authentication
//! (dsh-v0.1.2-alpha.1+) mints a SameSite cookie, which a cross-site child
//! frame does not store or resend, so the harness answers every request with
//! 401 `dsh web authentication required`. Serving the wrapper from
//! `http://127.0.0.1:<port>` (same scheme and host as the harness) puts the
//! iframe back on same-site ground, where its cookies work — and the harness
//! keeps its gate.
//!
//! The module embeds the page assets with `include_bytes!` so the server needs
//! no disk access and never depends on the checkout layout at runtime.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::thread::JoinHandle;

const INDEX_RAW: &[u8] = include_bytes!("../ui/index.html");
const APP_JS: &[u8] = include_bytes!("../ui/app.js");
const THEME_BRIDGE_JS: &[u8] = include_bytes!("../ui/theme-bridge.js");
const TITLEBAR_CSS: &[u8] = include_bytes!("../ui/titlebar.css");
const WINDOW_ICON: &[u8] = include_bytes!("../ui/window-icon.png");

/// Injected before `</body>`: reports whether the Tauri bridge is reachable
/// from this loopback origin, via `/__probe?step=...` (logged server-side).
const PROBE_JS: &str = r#"<script>(function(){try{var ti=window.__TAURI_INTERNALS__;if(!ti){fetch('/__probe?step=no-internals');return;}Promise.resolve(ti.invoke('shell_log',{msg:'ui-probe: tauri invoke ok'})).catch(function(e){fetch('/__probe?step=invoke-reject&msg='+encodeURIComponent(String(e&&e.message||e)));});}catch(e){fetch('/__probe?step=throw&msg='+encodeURIComponent(String(e)));}})();</script>"#;

/// The wrapper entry page: the embedded index.html with the probe injected.
fn index_doc() -> Vec<u8> {
    let raw = String::from_utf8_lossy(INDEX_RAW);
    match raw.rfind("</body>") {
        Some(at) => {
            let mut out = String::with_capacity(raw.len() + PROBE_JS.len());
            out.push_str(&raw[..at]);
            out.push_str(PROBE_JS);
            out.push_str(&raw[at..]);
            out.into_bytes()
        }
        None => INDEX_RAW.to_vec(),
    }
}

struct Asset {
    content_type: &'static str,
    body: Vec<u8>,
}

impl Asset {
    fn static_body(ct: &'static str, body: &'static [u8]) -> Self {
        Self {
            content_type: ct,
            body: body.to_vec(),
        }
    }
}

/// Loopback path → asset; `/__probe` records the diagnostic line instead.
fn asset(path: &str) -> Option<Asset> {
    match path {
        "/" | "/index.html" => Some(Asset {
            content_type: "text/html; charset=utf-8",
            body: index_doc(),
        }),
        "/app.js" => Some(Asset::static_body("text/javascript; charset=utf-8", APP_JS)),
        "/theme-bridge.js" => {
            Some(Asset::static_body("text/javascript; charset=utf-8", THEME_BRIDGE_JS))
        }
        "/titlebar.css" => Some(Asset::static_body("text/css; charset=utf-8", TITLEBAR_CSS)),
        "/window-icon.png" => Some(Asset::static_body("image/png", WINDOW_ICON)),
        _ => None,
    }
}

/// Bind and serve the wrapper page on the loopback port until the listener
/// fails. `probe_log` receives the `/__probe` diagnostics lines.
pub fn spawn(port: u16, probe_log: PathBuf) -> Result<JoinHandle<()>, String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("cannot bind wrapper page on 127.0.0.1:{port}: {e}"))?;
    let handle = std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let probe_log = probe_log.clone();
                    let _ = std::thread::spawn(move || handle_connection(stream, &probe_log));
                }
                Err(_) => break,
            }
        }
    });
    Ok(handle)
}

fn log_line(path: &PathBuf, line: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
        let _ = file.write_all(b"\n");
    }
}

fn handle_connection(mut stream: TcpStream, probe_log: &PathBuf) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(5)));
    let mut buf = [0u8; 8192];
    let mut head = Vec::new();
    loop {
        match stream.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => {
                head.extend_from_slice(&buf[..n]);
                if head.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if head.len() > 16384 {
                    return;
                }
            }
            Err(_) => return,
        }
    }
    let mut status = "404 Not Found";
    let mut content_type = "application/octet-stream";
    let mut body: Vec<u8> = Vec::new();
    if let Some(request_line) = head
        .split(|b| *b == b'\r' || *b == b'\n')
        .next()
        .and_then(|line| std::str::from_utf8(line).ok())
    {
        let mut parts = request_line.split_whitespace();
        if matches!(parts.next(), Some(method) if method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD")) {
            let path = parts.next().unwrap_or("/");
            let clean = path.split('?').next().unwrap_or(path);
            if clean == "/__probe" {
                let message = format!("[ui-probe] {}", path);
                log_line(probe_log, &message);
            } else if let Some(a) = asset(clean) {
                status = "200 OK";
                content_type = a.content_type;
                body = a.body;
            }
        }
    }
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.write_all(&body);
}

#[cfg(all(test, windows))]
mod tests {
    use super::asset;

    #[test]
    fn every_wrapper_path_resolves() {
        for path in ["/", "/index.html", "/app.js", "/theme-bridge.js", "/titlebar.css", "/window-icon.png"] {
            assert!(asset(path).is_some(), "missing asset for {path}");
        }
        assert!(asset("/etc/passwd").is_none());
    }
}
