use chardetng::EncodingDetector;
use encoding_rs::{Encoding, EUC_JP, SHIFT_JIS, UTF_8};

const ENCODING_SAMPLE_BYTES: usize = 16_384;

pub fn detect_encoding(bytes: &[u8]) -> &'static Encoding {
    // BOM check (UTF-8 BOM)
    if bytes.starts_with(b"\xEF\xBB\xBF") {
        return UTF_8;
    }

    let mut detector = EncodingDetector::new();
    let sample_size = bytes.len().min(ENCODING_SAMPLE_BYTES);
    detector.feed(&bytes[..sample_size], bytes.len() <= sample_size);

    let enc = detector.guess(None, true);

    match enc {
        e if e == SHIFT_JIS => SHIFT_JIS,
        e if e == EUC_JP => EUC_JP,
        _ => UTF_8,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_utf8_bom() {
        let bytes = b"\xEF\xBB\xBFhello";
        assert_eq!(detect_encoding(bytes), UTF_8);
    }

    #[test]
    fn defaults_to_utf8_for_ascii() {
        let bytes = b"id,name,value\n1,Alice,100\n";
        assert_eq!(detect_encoding(bytes), UTF_8);
    }
}
