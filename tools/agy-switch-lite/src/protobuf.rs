use base64::{engine::general_purpose, Engine as _};

pub fn encode_varint(mut value: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    while value >= 0x80 {
        buf.push((value & 0x7F | 0x80) as u8);
        value >>= 7;
    }
    buf.push(value as u8);
    buf
}

pub fn read_varint(data: &[u8], offset: usize) -> Result<(u64, usize), String> {
    let mut result = 0u64;
    let mut shift = 0;
    let mut pos = offset;
    loop {
        if pos >= data.len() {
            return Err("incomplete_data".to_string());
        }
        let byte = data[pos];
        if shift >= 64 || (shift == 63 && byte > 1) {
            return Err("varint_too_long".to_string());
        }
        result |= ((byte & 0x7F) as u64) << shift;
        pos += 1;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    Ok((result, pos))
}

pub fn skip_field(data: &[u8], offset: usize, wire_type: u8) -> Result<usize, String> {
    let bounded = |end: usize| -> Result<usize, String> {
        if end > data.len() {
            Err("incomplete_data".to_string())
        } else {
            Ok(end)
        }
    };
    match wire_type {
        0 => Ok(read_varint(data, offset)?.1),
        1 => bounded(offset.checked_add(8).ok_or("incomplete_data")?),
        2 => {
            let (len, content_offset) = read_varint(data, offset)?;
            let end = content_offset
                .checked_add(usize::try_from(len).map_err(|_| "incomplete_data")?)
                .ok_or("incomplete_data")?;
            bounded(end)
        }
        5 => bounded(offset.checked_add(4).ok_or("incomplete_data")?),
        _ => Err(format!("unknown_wire_type: {wire_type}")),
    }
}

pub fn encode_len_delim_field(field_num: u32, data: &[u8]) -> Vec<u8> {
    let tag = (field_num << 3) | 2;
    let mut f = encode_varint(tag as u64);
    f.extend(encode_varint(data.len() as u64));
    f.extend_from_slice(data);
    f
}

pub fn encode_string_field(field_num: u32, value: &str) -> Vec<u8> {
    encode_len_delim_field(field_num, value.as_bytes())
}

pub fn encode_varint_field(field_num: u32, value: u64) -> Vec<u8> {
    let tag = (field_num << 3) | 0;
    let mut f = encode_varint(tag as u64);
    f.extend(encode_varint(value));
    f
}

pub fn create_oauth_info(
    access_token: &str,
    refresh_token: &str,
    expiry: i64,
    mut is_gcp_tos: bool,
    id_token: Option<&str>,
    email: Option<&str>,
) -> Vec<u8> {
    if let Some(email_str) = email {
        let lower = email_str.to_ascii_lowercase();
        let domain = lower.split('@').nth(1).unwrap_or("");
        let is_personal = matches!(
            domain,
            "gmail.com" | "outlook.com" | "hotmail.com" | "qq.com" | "163.com"
        );
        if is_personal && is_gcp_tos {
            is_gcp_tos = false;
        }
    }
    let mut ts = encode_varint((1 << 3) | 0);
    ts.extend(encode_varint(expiry.max(0) as u64));
    ts.extend(encode_varint((2 << 3) | 0));
    ts.extend(encode_varint(0));

    let mut out = Vec::new();
    out.extend(encode_string_field(1, access_token));
    out.extend(encode_string_field(2, "Bearer"));
    out.extend(encode_string_field(3, refresh_token));
    out.extend(encode_len_delim_field(4, &ts));
    if let Some(it) = id_token {
        out.extend(encode_string_field(5, it));
    }
    if is_gcp_tos {
        out.extend(encode_varint_field(6, 1));
    }
    out
}

pub fn create_unified_state_entry(sentinel_key: &str, payload: &[u8]) -> String {
    let row = encode_string_field(1, &general_purpose::STANDARD.encode(payload));
    let data_entry = [
        encode_string_field(1, sentinel_key),
        encode_len_delim_field(2, &row),
    ]
    .concat();
    let topic = encode_len_delim_field(1, &data_entry);
    general_purpose::STANDARD.encode(topic)
}

pub fn create_unified_topic_entry(sentinel_key: &str, payload: &[u8]) -> Vec<u8> {
    let row = encode_string_field(1, &general_purpose::STANDARD.encode(payload));
    let entry = [
        encode_string_field(1, sentinel_key),
        encode_len_delim_field(2, &row),
    ]
    .concat();
    encode_len_delim_field(1, &entry)
}

pub fn create_minimal_user_status_payload(email: &str) -> Vec<u8> {
    [encode_string_field(3, email), encode_string_field(7, email)].concat()
}

pub fn create_string_value_payload(value: &str) -> Vec<u8> {
    encode_string_field(3, value)
}

fn unified_topic_entry_key(data: &[u8]) -> Option<&str> {
    let mut offset = 0;
    while offset < data.len() {
        let (tag, new_offset) = read_varint(data, offset).ok()?;
        let wire_type = (tag & 7) as u8;
        let field_num = (tag >> 3) as u32;
        if field_num == 1 && wire_type == 2 {
            let (len, content_offset) = read_varint(data, new_offset).ok()?;
            let end = content_offset.checked_add(usize::try_from(len).ok()?)?;
            if end > data.len() {
                return None;
            }
            return std::str::from_utf8(&data[content_offset..end]).ok();
        }
        offset = skip_field(data, new_offset, wire_type).ok()?;
    }
    None
}

pub fn remove_unified_topic_entry(data: &[u8], target_key: &str) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    let mut offset = 0;
    while offset < data.len() {
        let start = offset;
        let (tag, new_offset) = read_varint(data, offset)?;
        let wire_type = (tag & 7) as u8;
        let field_num = (tag >> 3) as u32;
        let next = skip_field(data, new_offset, wire_type)?;
        let should_remove = if field_num == 1 && wire_type == 2 {
            let (len, content_offset) = read_varint(data, new_offset)?;
            let end = content_offset
                .checked_add(usize::try_from(len).map_err(|_| "incomplete_data")?)
                .ok_or("incomplete_data")?;
            if end > data.len() {
                return Err("incomplete_data".to_string());
            }
            unified_topic_entry_key(&data[content_offset..end]) == Some(target_key)
        } else {
            false
        };
        if !should_remove {
            result.extend_from_slice(&data[start..next]);
        }
        offset = next;
    }
    Ok(result)
}
