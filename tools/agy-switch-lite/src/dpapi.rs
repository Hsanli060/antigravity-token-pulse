use base64::{engine::general_purpose, Engine as _};

pub const DPAPI_PREFIX: &str = "dpapi:v1:";
const ENTROPY_BYTES: &[u8] = b"agy-switch-lite:dpapi-v1";

pub fn is_protected(value: &str) -> bool {
    value.starts_with(DPAPI_PREFIX)
}

#[cfg(windows)]
mod win {
    use super::ENTROPY_BYTES;
    use std::ffi::c_void;

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x01;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;

        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    pub fn encrypt_bytes(plain: &[u8]) -> Result<Vec<u8>, String> {
        let mut input = plain.to_vec();
        let mut entropy = ENTROPY_BYTES.to_vec();
        let in_blob = DataBlob {
            cb_data: input.len() as u32,
            pb_data: input.as_mut_ptr(),
        };
        let entropy_blob = DataBlob {
            cb_data: entropy.len() as u32,
            pb_data: entropy.as_mut_ptr(),
        };
        let mut out_blob = DataBlob {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };

        let ok = unsafe {
            CryptProtectData(
                &in_blob,
                std::ptr::null(),
                &entropy_blob,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        if ok == 0 || out_blob.pb_data.is_null() {
            return Err("Windows DPAPI CryptProtectData failed".to_string());
        }
        let result = unsafe {
            std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize).to_vec()
        };
        unsafe {
            LocalFree(out_blob.pb_data as *mut c_void);
        }
        Ok(result)
    }

    pub fn decrypt_bytes(cipher: &[u8]) -> Result<Vec<u8>, String> {
        let mut input = cipher.to_vec();
        let mut entropy = ENTROPY_BYTES.to_vec();
        let in_blob = DataBlob {
            cb_data: input.len() as u32,
            pb_data: input.as_mut_ptr(),
        };
        let entropy_blob = DataBlob {
            cb_data: entropy.len() as u32,
            pb_data: entropy.as_mut_ptr(),
        };
        let mut out_blob = DataBlob {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };

        let ok = unsafe {
            CryptUnprotectData(
                &in_blob,
                std::ptr::null_mut(),
                &entropy_blob,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        if ok == 0 || out_blob.pb_data.is_null() {
            return Err("Windows DPAPI CryptUnprotectData failed".to_string());
        }
        let result = unsafe {
            std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize).to_vec()
        };
        unsafe {
            LocalFree(out_blob.pb_data as *mut c_void);
        }
        Ok(result)
    }
}

/// Encrypts a sensitive string with Windows DPAPI (CurrentUser scope).
/// Empty strings and already-encrypted `dpapi:v1:` strings are returned unchanged.
pub fn protect_string(plain: &str) -> Result<String, String> {
    if plain.is_empty() || is_protected(plain) {
        return Ok(plain.to_string());
    }
    #[cfg(windows)]
    {
        let cipher = win::encrypt_bytes(plain.as_bytes())?;
        Ok(format!(
            "{DPAPI_PREFIX}{}",
            general_purpose::STANDARD.encode(cipher)
        ))
    }
    #[cfg(not(windows))]
    {
        Ok(plain.to_string())
    }
}

/// Decrypts a string if it carries the `dpapi:v1:` prefix.
/// Returns `(plaintext, was_protected)` so callers can migrate legacy plaintext files automatically.
pub fn unprotect_string(raw: &str) -> Result<(String, bool), String> {
    if raw.is_empty() {
        return Ok((String::new(), true));
    }
    let Some(b64) = raw.strip_prefix(DPAPI_PREFIX) else {
        return Ok((raw.to_string(), false));
    };
    #[cfg(windows)]
    {
        let cipher = general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|e| format!("Invalid DPAPI base64 payload: {e}"))?;
        let plain_bytes = win::decrypt_bytes(&cipher)?;
        let plain = String::from_utf8(plain_bytes)
            .map_err(|e| format!("Invalid UTF-8 after DPAPI decrypt: {e}"))?;
        Ok((plain, true))
    }
    #[cfg(not(windows))]
    {
        let _ = b64;
        Err("DPAPI-protected tokens can only be decrypted on Windows".to_string())
    }
}
