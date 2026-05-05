pub fn detect_delimiter(content: &str) -> char {
    let candidates = [',', '\t', ';'];
    let lines: Vec<&str> = content.lines().take(20).collect();

    if lines.is_empty() {
        return ',';
    }

    let best = candidates.iter().max_by_key(|&&delim| {
        let counts: Vec<usize> = lines.iter().map(|l| l.matches(delim).count()).collect();

        if counts.iter().all(|&c| c == 0) {
            return 0;
        }

        let max = *counts.iter().max().unwrap_or(&0);
        let variance: usize = counts
            .iter()
            .map(|&c| (c as isize - max as isize).unsigned_abs())
            .sum();

        if variance == 0 {
            max * 100
        } else {
            max * 100 / (variance + 1)
        }
    });

    *best.unwrap_or(&',')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_comma() {
        let csv = "id,name,value\n1,Alice,100\n2,Bob,200\n";
        assert_eq!(detect_delimiter(csv), ',');
    }

    #[test]
    fn detects_tab() {
        let tsv = "id\tname\tvalue\n1\tAlice\t100\n2\tBob\t200\n";
        assert_eq!(detect_delimiter(tsv), '\t');
    }

    #[test]
    fn detects_semicolon() {
        let csv = "id;name;value\n1;Alice;100\n2;Bob;200\n";
        assert_eq!(detect_delimiter(csv), ';');
    }

    #[test]
    fn empty_defaults_to_comma() {
        assert_eq!(detect_delimiter(""), ',');
    }
}
