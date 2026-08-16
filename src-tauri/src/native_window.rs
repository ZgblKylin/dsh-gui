//! Native Windows frame interactions that Tauri's public window API does not
//! expose while a window is frameless (`decorations(false)`).
//!
//! Tauri's `TAURI_DRAG_RESIZE_BORDERS` child window implements border
//! resizing: on `WM_NCLBUTTONDOWN` it forwards the message to the parent,
//! whose default WndProc enters the Win32 modal resize loop. That loop
//! swallows the second click, so Windows 11's double-click-top-border
//! action never happens.
//!
//! We subclass that child window and add `CS_DBLCLKS`:
//! * the first top/bottom border click is held briefly instead of forwarded;
//! * if the pointer moves, the original resize path is started immediately;
//! * if a second click arrives, `WM_NCLBUTTONDBLCLK` is forwarded to the
//!   parent so its default WndProc performs the native vertical-fill action.
//! Everything else is forwarded to the existing tao/Tauri child WndProc.

use windows_sys::{
    w,
    Win32::{
        Foundation::{HWND, LRESULT, POINT, POINTS, WPARAM},
        UI::{
            Input::KeyboardAndMouse::{ReleaseCapture, SetCapture},
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                FindWindowExW, GetClassLongPtrW, GetCursorPos, GetParent, PostMessageW,
                SetClassLongPtrW, CS_DBLCLKS, GCL_STYLE, HTBOTTOM, HTTOP, SC_SIZE,
                WM_CAPTURECHANGED, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCDESTROY, WM_NCHITTEST,
                WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_SYSCOMMAND,
            },
        },
    },
};

/// Must not collide with tao's subclass ids (`0` and `1`).
const RESIZE_CHILD_SUBCLASS_ID: usize = 0x4453_485f_4544; // DSH_ED

struct BorderDragState {
    edge: u32,
    x: i32,
    y: i32,
}

impl Default for BorderDragState {
    fn default() -> Self {
        Self {
            edge: 0,
            x: 0,
            y: 0,
        }
    }
}

/// Install the double-click forwarding subclass on Tauri's frameless resize
/// child window.
pub fn install(hwnd: HWND) {
    unsafe {
        let child = FindWindowExW(
            hwnd,
            std::ptr::null_mut(),
            w!("TAURI_DRAG_RESIZE_BORDERS"),
            w!("TAURI_DRAG_RESIZE_WINDOW"),
        );
        if child.is_null() {
            return;
        }

        let child_style = GetClassLongPtrW(child, GCL_STYLE) as u32;
        SetClassLongPtrW(child, GCL_STYLE, (child_style | CS_DBLCLKS) as isize);
        let state = Box::into_raw(Box::new(BorderDragState::default()));
        SetWindowSubclass(
            child,
            Some(resize_child_subclass_proc),
            RESIZE_CHILD_SUBCLASS_ID,
            state as usize,
        );
    }
}

/// Start the native "Size" system command for the window-control menu.
pub fn start_system_size(hwnd: HWND) {
    unsafe {
        PostMessageW(hwnd, WM_SYSCOMMAND, SC_SIZE as WPARAM, 0);
    }
}

unsafe extern "system" fn resize_child_subclass_proc(
    child: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
    _subclass_id: usize,
    ref_data: usize,
) -> LRESULT {
    if ref_data == 0 {
        return DefSubclassProc(child, msg, wparam, lparam);
    }
    let state = &mut *(ref_data as *mut BorderDragState);

    if msg == WM_NCDESTROY {
        RemoveWindowSubclass(
            child,
            Some(resize_child_subclass_proc),
            RESIZE_CHILD_SUBCLASS_ID,
        );
        drop(Box::from_raw(ref_data as *mut BorderDragState));
        return DefSubclassProc(child, msg, wparam, lparam);
    }

    // The non-client button messages carry the hit-test result in wparam.
    // Fall back to the original child WndProc when wparam is empty (calling
    // SendMessageW here would just re-enter this subclass).
    let hit = match msg {
        WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK if wparam == 0 => {
            DefSubclassProc(child, WM_NCHITTEST, wparam, lparam) as u32
        }
        _ => wparam as u32,
    };

    match msg {
        WM_NCLBUTTONDOWN if hit == HTTOP || hit == HTBOTTOM => {
            let mut cursor = POINT { x: 0, y: 0 };
            if GetCursorPos(&mut cursor) == 0 {
                return DefSubclassProc(child, msg, wparam, lparam);
            }
            state.edge = hit;
            state.x = cursor.x;
            state.y = cursor.y;
            SetCapture(child);
            return 0; // Hold this click until it proves to be a drag or half of a double-click.
        }

        WM_NCLBUTTONDBLCLK if hit == HTTOP || hit == HTBOTTOM => {
            let parent = GetParent(child);
            if !parent.is_null() {
                PostMessageW(parent, WM_NCLBUTTONDBLCLK, hit as WPARAM, lparam);
            }
            *state = BorderDragState::default();
            ReleaseCapture();
            return 0;
        }

        WM_MOUSEMOVE if state.edge != 0 => {
            let mut cursor = POINT { x: 0, y: 0 };
            if GetCursorPos(&mut cursor) == 0 {
                return 0;
            }
            if (cursor.x - state.x).abs() >= BORDER_DRAG_THRESHOLD_PX
                || (cursor.y - state.y).abs() >= BORDER_DRAG_THRESHOLD_PX
            {
                let parent = GetParent(child);
                if !parent.is_null() {
                    let points = POINTS {
                        x: cursor.x as i16,
                        y: cursor.y as i16,
                    };
                    PostMessageW(
                        parent,
                        WM_NCLBUTTONDOWN,
                        state.edge as WPARAM,
                        &points as *const POINTS as isize,
                    );
                }
                *state = BorderDragState::default();
                ReleaseCapture();
            }
            return 0;
        }

        WM_LBUTTONUP | WM_NCLBUTTONUP if state.edge != 0 => {
            *state = BorderDragState::default();
            ReleaseCapture();
            return 0;
        }

        WM_CAPTURECHANGED if state.edge != 0 => {
            *state = BorderDragState::default();
            return 0;
        }

        _ => {}
    }

    DefSubclassProc(child, msg, wparam, lparam)
}

/// A few physical pixels are enough to distinguish a click from a resize drag.
const BORDER_DRAG_THRESHOLD_PX: i32 = 3;
