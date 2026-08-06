//! The mandatory security barrier for any SQL string composed from user
//! input (`where` predicates, `sql`-mode queries). See
//! docs/SEARCH_ARCHITECTURE.md §4 for why `Connection::prepare()` alone
//! cannot be trusted as this boundary: it silently *executes* all but the
//! last statement of a multi-statement input before ever preparing the
//! final one, so e.g. `csv_data) LIMIT 1; DROP TABLE csv_data; --` runs the
//! DROP before any wrapping `LIMIT` or `prepare()` call ever sees it.
mod validate;
mod wrap;

pub(crate) use wrap::{wrap_ctas, wrap_select, MAX_RESULT_ROWS};
