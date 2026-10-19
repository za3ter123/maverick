// app-audio.exe <hwnd> | pid:<pid>
// The sound of one app only: Windows process loopback (Windows 10 2004 and later) of the process that owns the window,
// with everything it started (Teams plays through its WebView2 children, Chrome through its audio service). Its calls
// (Communications streams, which process loopback leaves out) come from the device it plays on; see Tap.
// stderr, one JSON line first: {"ok":true,"pid":N,"exe":"Zoom.exe","session":true} or {"ok":false,"error":"..."}.
// stdout after it: raw PCM, 16-bit little endian, 48000 Hz, stereo, until stdin closes (the app quit) or a write fails.
// Built by build.ps1 next to this folder; desktop/main.cjs runs the copy at desktop/app-audio.exe.
use std::collections::{HashSet, VecDeque};
use std::io::{Read, Write};
use std::mem::ManuallyDrop;
use std::time::{Duration, Instant};
use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Media::Audio::*;
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::System::Com::StructuredStorage::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Diagnostics::ToolHelp::*;
use windows::Win32::System::Threading::*;
use windows::Win32::System::Variant::VT_BLOB;
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

const RATE: u32 = 48000;

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Done(HANDLE);
impl IActivateAudioInterfaceCompletionHandler_Impl for Done_Impl {
    fn ActivateCompleted(&self, _op: Ref<IActivateAudioInterfaceAsyncOperation>) -> Result<()> {
        unsafe { SetEvent(self.0) }
    }
}

fn say(ok: bool, body: &str) {
    eprintln!("{{\"ok\":{ok},{body}}}");
}

// The process and every process under it, with the root's exe name.
fn tree(root: u32) -> (HashSet<u32>, String) {
    let mut rows = Vec::new();
    let mut exe = String::new();
    unsafe {
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut more = Process32FirstW(snap, &mut e).is_ok();
            while more {
                if e.th32ProcessID == root {
                    let n = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                    exe = String::from_utf16_lossy(&e.szExeFile[..n]);
                }
                rows.push((e.th32ProcessID, e.th32ParentProcessID));
                more = Process32NextW(snap, &mut e).is_ok();
            }
            let _ = CloseHandle(snap);
        }
    }
    let mut set = HashSet::from([root]);
    let mut grew = true;
    while grew {
        grew = false;
        for &(p, pp) in &rows {
            if p != 0 && set.contains(&pp) && set.insert(p) { grew = true; }
        }
    }
    (set, exe)
}

// The active output devices where a process in the tree has an audio session: (device id, device, its session manager).
unsafe fn endpoints(pids: &HashSet<u32>) -> Result<Vec<(String, IMMDevice, IAudioSessionManager2)>> {
    unsafe {
        let mut out = Vec::new();
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devs = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        for i in 0..devs.GetCount()? {
            let dev = devs.Item(i)?;
            let Ok(m) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let list = m.GetSessionEnumerator()?;
            for j in 0..list.GetCount()? {
                let Ok(c) = list.GetSession(j)?.cast::<IAudioSessionControl2>() else { continue };
                if pids.contains(&c.GetProcessId().unwrap_or(0)) {
                    let id = dev.GetId()?;
                    out.push((id.to_string().unwrap_or_default(), dev, m));
                    CoTaskMemFree(Some(id.0 as _));
                    break;
                }
            }
        }
        Ok(out)
    }
}

// Whether a process outside the tree is making sound on this device now. Any doubt counts as yes.
unsafe fn others_audible(m: &IAudioSessionManager2, pids: &HashSet<u32>) -> bool {
    unsafe {
        let Ok(list) = m.GetSessionEnumerator() else { return true };
        for j in 0..list.GetCount().unwrap_or(0) {
            let Ok(s) = list.GetSession(j) else { return true };
            let Ok(c) = s.cast::<IAudioSessionControl2>() else { return true };
            // This helper's own device loopback is a session here too, metering the whole device.
            let p = c.GetProcessId().unwrap_or(0);
            if pids.contains(&p) || p == std::process::id() { continue; }
            let Ok(meter) = s.cast::<IAudioMeterInformation>() else { return true };
            if meter.GetPeakValue().unwrap_or(1.0) > 1e-4 { return true; }
        }
        false
    }
}

// Process loopback leaves out every stream in the Communications category (measured 2026-10-19: a test renderer's
// 600 Hz came through at -10 dBFS as Other and at the -99.7 dBFS floor as Communications, include and exclude mode
// alike). The new Teams plays the call that way, so for that sound we take the whole device the tree plays on and keep
// it only while no other process there makes a sound.
struct Tap {
    id: String,
    _client: IAudioClient, // kept alive: the capture stops when it is released
    cap: IAudioCaptureClient,
    sessions: IAudioSessionManager2,
    fifo: VecDeque<i16>,
    closed_until: Instant,
}
const TAP_DELAY: usize = 2400 * 2; // 50 ms of samples held back, so the meters see another process before its sound is used
const TAP_MAX: usize = TAP_DELAY + 9600 * 2; // drift bound: older samples are dropped
const TAP_HOLD: Duration = Duration::from_millis(300); // stays shut this long after another process was last heard

unsafe fn tap(id: String, dev: &IMMDevice, sessions: IAudioSessionManager2) -> Result<Tap> {
    unsafe {
        let client: IAudioClient = dev.Activate(CLSCTX_ALL, None)?;
        let fmt = WAVEFORMATEX { wFormatTag: WAVE_FORMAT_PCM as u16, nChannels: 2, nSamplesPerSec: RATE, nAvgBytesPerSec: RATE * 4, nBlockAlign: 4, wBitsPerSample: 16, cbSize: 0 };
        client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 2_000_000, 0, &fmt, None)?;
        let cap: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        Ok(Tap { id, _client: client, cap, sessions, fifo: VecDeque::new(), closed_until: Instant::now() })
    }
}

impl Tap {
    unsafe fn drain(&mut self) {
        unsafe {
            while let Ok(n) = self.cap.GetNextPacketSize() {
                if n == 0 { break; }
                let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                if self.cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None).is_err() { break; }
                let len = frames as usize * 2;
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                    self.fifo.extend(std::iter::repeat_n(0, len));
                } else {
                    self.fifo.extend(std::slice::from_raw_parts(data as *const i16, len));
                }
                let _ = self.cap.ReleaseBuffer(frames);
            }
            let over = self.fifo.len().saturating_sub(TAP_MAX);
            self.fifo.drain(..over);
        }
    }

    // Takes the next len samples past the delay; adds them to out when wanted and the device has only the tree's sound.
    unsafe fn mix(&mut self, out: &mut [i16], wanted: bool, pids: &HashSet<u32>) {
        let n = out.len().min(self.fifo.len().saturating_sub(TAP_DELAY));
        let now = Instant::now();
        if wanted && unsafe { others_audible(&self.sessions, pids) } { self.closed_until = now + TAP_HOLD; }
        let open = wanted && now >= self.closed_until;
        for (o, s) in out.iter_mut().zip(self.fifo.drain(..n)) {
            if open { *o = o.saturating_add(s); }
        }
    }
}

unsafe fn capture(pid: u32) -> Result<(IAudioClient, IAudioCaptureClient, HANDLE)> {
    unsafe {
        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };
        // ManuallyDrop: PROPVARIANT's Drop is PropVariantClear, which would free the blob, here a stack address.
        let pv = ManuallyDrop::new(PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        blob: BLOB { cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, pBlobData: &mut params as *mut _ as *mut u8 },
                    },
                }),
            },
        });
        let done = CreateEventW(None, false, false, None)?;
        let handler: IActivateAudioInterfaceCompletionHandler = Done(done).into();
        let op = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*pv), &handler)?;
        if WaitForSingleObject(done, 5000) != WAIT_OBJECT_0 { return Err(Error::new(E_FAIL, "activation timed out")); }
        let mut hr = HRESULT(0);
        let mut unk: Option<IUnknown> = None;
        op.GetActivateResult(&mut hr, &mut unk)?;
        hr.ok()?;
        let client: IAudioClient = unk.ok_or_else(|| Error::new(E_FAIL, "no audio client"))?.cast()?;
        let fmt = WAVEFORMATEX { wFormatTag: WAVE_FORMAT_PCM as u16, nChannels: 2, nSamplesPerSec: RATE, nAvgBytesPerSec: RATE * 4, nBlockAlign: 4, wBitsPerSample: 16, cbSize: 0 };
        let flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
        client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, &fmt, None)?;
        let cap: IAudioCaptureClient = client.GetService()?;
        let ready = CreateEventW(None, false, false, None)?;
        client.SetEventHandle(ready)?;
        Ok((client, cap, ready))
    }
}

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_default();
    let pid = if let Some(p) = arg.strip_prefix("pid:") {
        p.parse().unwrap_or(0)
    } else {
        let mut p = 0u32;
        if let Ok(h) = arg.parse::<isize>() { unsafe { GetWindowThreadProcessId(HWND(h as *mut _), Some(&mut p)) }; }
        p
    };
    if pid == 0 { return say(false, "\"error\":\"no-window\""); }
    let (mut pids, exe) = tree(pid);
    let exe = exe.replace(['"', '\\'], "");
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let found = endpoints(&pids).unwrap_or_default();
        let session = !found.is_empty();
        let (client, cap, ready) = match capture(pid) {
            Ok(c) => c,
            Err(e) => return say(false, &format!("\"error\":\"unavailable\",\"detail\":\"{:#010x}\",\"pid\":{pid},\"exe\":\"{exe}\"", e.code().0)),
        };
        say(true, &format!("\"pid\":{pid},\"exe\":\"{exe}\",\"session\":{session}"));
        // The parent closes stdin when it stops this capture or dies: nothing is left running.
        std::thread::spawn(|| { let _ = std::io::stdin().read_to_end(&mut Vec::new()); std::process::exit(0); });
        if client.Start().is_err() { std::process::exit(1); }
        let mut out = std::io::stdout().lock();
        let mut taps: Vec<Tap> = found.into_iter().filter_map(|(id, dev, m)| tap(id, &dev, m).ok()).collect();
        let mut scanned = Instant::now();
        let mut buf: Vec<i16> = Vec::new();
        loop {
            WaitForSingleObject(ready, 1000);
            // The tree can start children and open devices after the start.
            if scanned.elapsed() > Duration::from_secs(1) {
                scanned = Instant::now();
                pids = tree(pid).0;
                for (id, dev, m) in endpoints(&pids).unwrap_or_default() {
                    if !taps.iter().any(|t| t.id == id) { if let Ok(t) = tap(id, &dev, m) { taps.push(t); } }
                }
            }
            for t in &mut taps { t.drain(); }
            while let Ok(n) = cap.GetNextPacketSize() {
                if n == 0 { break; }
                let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                if cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None).is_err() { std::process::exit(1); }
                let len = frames as usize * 2;
                buf.clear();
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                    buf.resize(len, 0);
                } else {
                    buf.extend_from_slice(std::slice::from_raw_parts(data as *const i16, len));
                }
                let _ = cap.ReleaseBuffer(frames);
                // The device taps carry the tree's other streams too: used only when process loopback hears nothing.
                let quiet = buf.iter().all(|s| s.unsigned_abs() <= 4);
                for t in &mut taps { t.mix(&mut buf, quiet, &pids); }
                let bytes = std::slice::from_raw_parts(buf.as_ptr() as *const u8, len * 2);
                if out.write_all(bytes).and_then(|_| out.flush()).is_err() { std::process::exit(0); }
            }
        }
    }
}
