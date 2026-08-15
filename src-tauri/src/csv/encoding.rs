use chardetng::EncodingDetector;
use encoding_rs::{Encoding, EUC_JP, SHIFT_JIS, UTF_8};

const ENCODING_SAMPLE_BYTES: usize = 16_384;

pub struct Detection {
    pub encoding: &'static Encoding,
    /// False when the guess is likely wrong (chardetng scored it no higher
    /// than another candidate) or when the guess was an encoding this app
    /// doesn't map to a known variant (in which case we substitute UTF-8 and
    /// say so, rather than silently mislabeling the file). Drives the
    /// manual-encoding-selector notice (docs/IMPLEMENTATION.md §4.5).
    pub confident: bool,
}

pub fn detect_encoding(bytes: &[u8]) -> Detection {
    // BOM check (UTF-8 BOM) — definitive, no chardetng scoring involved.
    if bytes.starts_with(b"\xEF\xBB\xBF") {
        return Detection {
            encoding: UTF_8,
            confident: true,
        };
    }

    let mut detector = EncodingDetector::new();
    let sample_size = bytes.len().min(ENCODING_SAMPLE_BYTES);
    detector.feed(&bytes[..sample_size], bytes.len() <= sample_size);

    // `guess_assess`'s second element is false when the guessed encoding
    // scored no higher than at least one other candidate — chardetng's own
    // signal that the guess is likely wrong. Note this can only be false for
    // byte streams that are not valid UTF-8: `allow_utf8=true` makes valid
    // UTF-8/ASCII input short-circuit to `(UTF_8, true)` before any scoring
    // happens, so this never misfires on an ordinary UTF-8 CSV.
    let (enc, assessed) = detector.guess_assess(None, true);

    match enc {
        e if e == SHIFT_JIS => Detection {
            encoding: SHIFT_JIS,
            confident: assessed,
        },
        e if e == EUC_JP => Detection {
            encoding: EUC_JP,
            confident: assessed,
        },
        e if e == UTF_8 => Detection {
            encoding: UTF_8,
            confident: assessed,
        },
        // Anything else chardetng might guess (Windows-1252, GBK, Big5, ...)
        // isn't a variant this app's non-override load path decodes with —
        // falling back to UTF-8 here is a guess, not a detection, so it must
        // never be reported as confident.
        _ => Detection {
            encoding: UTF_8,
            confident: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_utf8_bom() {
        let bytes = b"\xEF\xBB\xBFhello";
        let detection = detect_encoding(bytes);
        assert_eq!(detection.encoding, UTF_8);
        assert!(detection.confident);
    }

    #[test]
    fn defaults_to_utf8_for_ascii() {
        let bytes = b"id,name,value\n1,Alice,100\n";
        let detection = detect_encoding(bytes);
        assert_eq!(detection.encoding, UTF_8);
        assert!(detection.confident);
    }

    #[test]
    fn detects_shift_jis_confidently() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-data/sjis_sample.csv");
        let bytes = std::fs::read(path).expect("fixture should exist");
        let detection = detect_encoding(&bytes);
        assert_eq!(detection.encoding, SHIFT_JIS);
        assert!(detection.confident);
    }

    #[test]
    fn an_unmapped_legacy_encoding_falls_back_to_utf8_without_confidence() {
        // windows-1252-style accented bytes repeated to give the detector
        // enough signal to steer away from Shift_JIS/EUC-JP/UTF-8, landing on
        // some other legacy encoding this app doesn't map — the `_` arm must
        // report UTF-8 without confidence rather than silently mislabeling
        // the file, regardless of exactly which encoding chardetng guesses.
        let mut bytes = Vec::new();
        for _ in 0..200 {
            bytes.extend_from_slice(b"caf\xe9,S\xe3o Paulo,Z\xfcrich\n");
        }
        let detection = detect_encoding(&bytes);
        assert_eq!(detection.encoding, UTF_8);
        assert!(!detection.confident);
    }
}
