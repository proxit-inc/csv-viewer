# CSV Viewer 実装ドキュメント

**バージョン**: 1.0  
**作成日**: 2026年2月  
**ステータス**: 実装準備完了

---

## 目次

1. [プロジェクト概要](#1-プロジェクト概要)
2. [技術スタック](#2-技術スタック)
3. [アーキテクチャ](#3-アーキテクチャ)
4. [機能要件](#4-機能要件)
5. [非機能要件](#5-非機能要件)
6. [UIコンポーネント設計](#6-uiコンポーネント設計)
7. [データモデル](#7-データモデル)
8. [Tauri IPC API設計](#8-tauri-ipc-api設計)
9. [DuckDB設計](#9-duckdb設計)
10. [フロントエンド実装](#10-フロントエンド実装)
11. [バックエンド実装](#11-バックエンド実装)
12. [実装時の懸念点・対策](#12-実装時の懸念点対策)
13. [開発フェーズ](#13-開発フェーズ)
14. [プロジェクトセットアップ](#14-プロジェクトセットアップ)
15. [参考OSSリポジトリ](#15-参考ossリポジトリ)

---

## 1. プロジェクト概要

### 目的
macOS上でローカル動作する、10万件規模のCSVファイルを複数タブで快適に閲覧できるデスクトップアプリケーション。

### 基本方針
- **読み取り専用**のビューアーとして Phase 1 を完成させる
- Phase 2 でソート・フィルタリングを追加する拡張性を最初から設計に組み込む
- SmoothCSV のデザインをベースにしたUI
- **Duckling** の実装をベース参考として、不要な機能（DB接続、Parquet等）を削除する

### スコープ
| フェーズ | 内容 |
|---------|------|
| **Phase 1**（本ドキュメントの対象） | 複数タブ対応のCSVビューアー |
| Phase 2（将来） | ソート・フィルタリング・検索の高度化 |
| Phase 3（将来） | セル編集・エクスポート |

---

## 2. 技術スタック

| 層 | 技術 | バージョン | 選定理由 |
|----|------|-----------|---------|
| デスクトップフレームワーク | Tauri | 2.x | 軽量・セキュア・Rust統合 |
| バックエンド言語 | Rust | 1.70+ | メモリ安全・高速I/O |
| CSV/データ処理 | DuckDB | 最新 | 列指向・高速クエリ・Phase 2拡張容易 |
| CSVパース補助 | csv crate | 1.x | Rustネイティブパーサー |
| エンコーディング検出 | chardetng + encoding_rs | 最新 | Shift_JIS / EUC-JP 対応 |
| フロントエンドフレームワーク | React | 18.x | エコシステム・仮想スクロール充実 |
| 言語 | TypeScript | 5.x | 型安全 |
| テーブルUI | AG-Grid Community | 31.x | 仮想スクロール・列リサイズ組込み |
| スタイリング | Tailwind CSS | 3.x | ユーティリティファースト |
| アイコン | lucide-react | 最新 | 軽量・macOS親和性 |
| ビルドツール | Vite | 5.x | 高速HMR |

### Cargo.toml（主要依存）

```toml
[dependencies]
tauri          = { version = "2.0", features = [] }
serde          = { version = "1.0", features = ["derive"] }
serde_json     = "1.0"
duckdb         = { version = "0.10", features = ["bundled"] }
csv            = "1.3"
encoding_rs    = "0.8"
chardetng      = "0.1"
thiserror      = "1.0"
rayon          = "1.8"   # 並列検索（Phase 1.4〜）
```

### package.json（主要依存）

```json
{
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/plugin-dialog": "^2.0.0",
    "ag-grid-community": "^31.0.0",
    "ag-grid-react": "^31.0.0",
    "lucide-react": "^0.294.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "@vitejs/plugin-react": "^4.2.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.3.0",
    "vite": "^5.0.0"
  }
}
```

---

## 3. アーキテクチャ

### システム全体構成

```
┌──────────────────────────────────────────────────┐
│                 macOS Application                │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │           Frontend (React + TS)            │  │
│  │                                            │  │
│  │  App                                       │  │
│  │  ├── TitleBar                              │  │
│  │  ├── Toolbar                               │  │
│  │  ├── TabBar  ← 複数ファイル管理            │  │
│  │  ├── FileInfoBar                           │  │
│  │  ├── SearchBar (インライン)                │  │
│  │  ├── DataGrid (AG-Grid Infinite)           │  │
│  │  ├── EmptyState                            │  │
│  │  └── StatusBar                             │  │
│  └───────────────────┬────────────────────────┘  │
│                      │ Tauri IPC (invoke/listen)  │
│  ┌───────────────────▼────────────────────────┐  │
│  │           Backend (Rust)                   │  │
│  │                                            │  │
│  │  Commands                                  │  │
│  │  ├── open_csv_file(path, tab_id)           │  │
│  │  ├── get_csv_data_range(tab_id, s, e)      │  │
│  │  ├── search_csv(tab_id, query)             │  │
│  │  └── close_tab(tab_id)                     │  │
│  │                                            │  │
│  │  DuckDBState                               │  │
│  │  └── HashMap<tab_id, Connection>           │  │
│  │       ├── tab_1: Connection (sales.csv)    │  │
│  │       ├── tab_2: Connection (customers.csv)│  │
│  │       └── tab_3: Connection (...)          │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### データフロー

#### ファイル読み込み
```
[User] ファイル選択 / D&D
  → [Frontend] invoke("open_csv_file", { path, tabId })
  → [Rust] エンコーディング検出
  → [Rust] 区切り文字検出
  → [Rust] DuckDB: CREATE TABLE AS SELECT * FROM read_csv_auto(path)
  → [Rust] メタデータ取得（行数・列数・ヘッダー）
  → [Frontend] タブ情報・FileInfoBar 更新
  → [Frontend] AG-Grid 初期化
```

#### 仮想スクロール（データ取得）
```
[User] スクロール
  → [AG-Grid] IDataSource.getRows({ startRow, endRow })
  → [Frontend] invoke("get_csv_data_range", { tabId, startRow, endRow })
  → [Rust] DuckDB: SELECT * FROM csv_data LIMIT n OFFSET m
  → [Frontend] AG-Grid に rows を渡す → 描画
```

---

## 4. 機能要件

### 4.1 ファイル操作

| ID | 機能 | 優先度 | 詳細 |
|----|------|--------|------|
| FR-001 | ファイル選択 | 必須 | ダイアログ（⌘O）・ドラッグ&ドロップ |
| FR-002 | 複数タブ | 必須 | 各タブが独立したDuckDB接続を保持 |
| FR-003 | エンコーディング対応 | 必須 | UTF-8 / Shift_JIS / EUC-JP 自動検出 |
| FR-004 | 区切り文字検出 | 必須 | カンマ・タブ・セミコロン 自動検出 |
| FR-005 | タブを閉じる | 必須 | DuckDB接続のクリーンアップ含む |

**対応ファイル拡張子**: `.csv` / `.tsv` / `.txt`

### 4.2 データ表示

| ID | 機能 | 優先度 | 詳細 |
|----|------|--------|------|
| FR-010 | テーブル表示 | 必須 | AG-Grid Infinite Row Model で仮想スクロール |
| FR-011 | ヘッダー固定 | 必須 | スクロール中も上部固定 |
| FR-012 | 行番号 | 必須 | 左端に固定、等幅フォント |
| FR-013 | ゼブラストライプ | 必須 | 1行おきに背景色変更 |
| FR-014 | 列幅調整 | 高 | ヘッダー境界ドラッグ + ダブルクリック自動調整 |
| FR-015 | 横スクロール | 必須 | 多カラム対応 |
| FR-016 | ファイル情報表示 | 必須 | ファイル名・行数・列数・エンコーディング・サイズ |

### 4.3 検索

| ID | 機能 | 優先度 | 詳細 |
|----|------|--------|------|
| FR-020 | テキスト検索 | 中 | ⌘F でインライン検索バー表示 |
| FR-021 | ハイライト | 中 | ヒットセルをハイライト |
| FR-022 | 結果ナビゲーション | 中 | 次へ（Enter）・前へ（Shift+Enter）|
| FR-023 | 件数表示 | 中 | "3 / 42 件" 形式 |

### 4.4 キーボードショートカット

| ショートカット | 機能 |
|--------------|------|
| ⌘O | ファイルを開く |
| ⌘F | 検索バーを開く / フォーカス |
| ESC | 検索バーを閉じる |
| Enter | 次の検索結果 |
| Shift+Enter | 前の検索結果 |
| ⌘W | アクティブタブを閉じる |
| ⌘Q | アプリ終了 |
| ⌘1〜9 | タブ切り替え |

### 4.5 エラーハンドリング

| シナリオ | 表示内容 |
|---------|---------|
| ファイル読み込み失敗 | ステータスバー + トースト通知 |
| エンコーディング検出失敗 | 手動選択ダイアログを提示 |
| 不正なCSV形式 | 部分的に読み込んで警告表示 |
| 1,000,000 行超 | 警告ダイアログ（続行可） |
| DuckDB接続エラー | タブに ⚠ アイコン表示 |

---

## 5. 非機能要件

| 項目 | 目標値 |
|------|--------|
| ファイル読み込み（10万行） | 3秒以内 |
| 初期描画 | 1秒以内 |
| スクロールFPS | 60fps 維持 |
| メモリ使用量（10万行） | 200MB 以内（DuckDB効果で削減） |
| アプリ起動時間 | 2秒以内 |
| 対応macOS | 11 (Big Sur) 以降 |
| アーキテクチャ | Intel (x86_64) + Apple Silicon (arm64) Universal Binary |
| 外部通信 | なし（完全オフライン） |

---

## 6. UIコンポーネント設計

### 6.1 レイアウト構造

```
┌─────────────────────────────────────────────┐  38px
│ ● ● ●   CSV Viewer                         │  TitleBar
├─────────────────────────────────────────────┤  44px
│ [Open] | [Search] [Sort*] [Filter*]  [⚙️] │  Toolbar
├─────────────────────────────────────────────┤  34px
│ [sales.csv ✕] [customers.csv ● ✕] [+]     │  TabBar
├─────────────────────────────────────────────┤  28px
│ 📄 sales.csv • 100,000 rows • UTF-8 • ,   │  FileInfoBar
├─────────────────────────────────────────────┤  38px（⌘F時のみ表示）
│ 🔍 [Tokyo____________] 3/42件 [↑][↓]  ✕  │  SearchBar
├─────────────────────────────────────────────┤
│ #  │ id   │ date       │ customer_name │ …  │  Grid Header（固定）
├────┼──────┼────────────┼───────────────┼────┤
│  1 │ 1001 │ 2024-01-05 │ 田中 太郎     │    │
│  2 │ 1002 │ 2024-01-06 │ Sakura Inc    │    │  DataGrid
│  … │  …   │     …      │      …        │    │  （仮想スクロール）
├─────────────────────────────────────────────┤  24px
│ ● Ready │ 1–100 / 100,000 行  D12 │ 3 tabs │  StatusBar
└─────────────────────────────────────────────┘
```

> `*` = Phase 2 で有効化（Phase 1では disabled 表示）

### 6.2 コンポーネント一覧

```
src/
├── App.tsx                       # ルート・グローバル状態
├── components/
│   ├── TitleBar.tsx              # macOS traffic lights
│   ├── Toolbar.tsx               # ボタン群
│   ├── TabBar/
│   │   ├── TabBar.tsx            # タブコンテナ
│   │   └── Tab.tsx               # 個別タブ
│   ├── FileInfoBar.tsx           # ファイルメタデータ表示
│   ├── SearchBar.tsx             # インライン検索（条件付き表示）
│   ├── DataGrid/
│   │   ├── DataGrid.tsx          # AG-Grid ラッパー
│   │   └── datasource.ts        # IDataSource 実装
│   ├── EmptyState.tsx            # ファイル未オープン時
│   └── StatusBar.tsx
├── hooks/
│   ├── useTabManager.ts          # タブ追加・切替・削除
│   ├── useFileOpen.ts            # ダイアログ + D&D
│   ├── useSearch.ts              # 検索状態管理
│   └── useKeyboardShortcuts.ts   # ショートカット登録
├── store/
│   └── appReducer.ts             # useReducer による状態管理
└── types/
    └── index.ts                  # 共通型定義
```

### 6.3 状態管理

```typescript
// types/index.ts

export interface CsvTab {
  id: string                // uuid
  filePath: string
  filename: string
  metadata: FileMetadata | null
  isLoading: boolean
  scrollOffset: number      // タブ復帰時のスクロール位置
  searchQuery: string       // タブ別検索クエリ
  searchHits: SearchHit[]
  searchHitIndex: number
}

export interface FileMetadata {
  filename: string
  filePath: string
  fileSize: number          // bytes
  totalRows: number
  totalColumns: number
  encoding: string          // "UTF-8" | "Shift_JIS" | "EUC-JP"
  delimiter: string         // "," | "\t" | ";"
  headers: string[]
}

export interface SearchHit {
  row: number
  column: number
}

export interface AppState {
  tabs: CsvTab[]
  activeTabId: string | null
  isSearchOpen: boolean
}

// --- Actions ---
export type AppAction =
  | { type: 'TAB_ADD';    payload: CsvTab }
  | { type: 'TAB_CLOSE';  payload: { tabId: string } }
  | { type: 'TAB_SWITCH'; payload: { tabId: string } }
  | { type: 'TAB_METADATA_LOADED'; payload: { tabId: string; metadata: FileMetadata } }
  | { type: 'TAB_SCROLL_SAVE';     payload: { tabId: string; offset: number } }
  | { type: 'SEARCH_OPEN' }
  | { type: 'SEARCH_CLOSE' }
  | { type: 'SEARCH_UPDATE'; payload: { tabId: string; query: string; hits: SearchHit[] } }
  | { type: 'SEARCH_NAVIGATE'; payload: { tabId: string; index: number } }
```

### 6.4 デザイントークン

```css
:root {
  /* Font */
  --font-sans: "SF Pro Text", -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: "SF Mono", "Cascadia Code", Consolas, monospace;

  /* Neutral */
  --col-bg:        #FFFFFF;
  --col-surface:   #F5F5F5;
  --col-surface2:  #EBEBEB;
  --col-border:    #D6D6D6;
  --col-border2:   #C4C4C4;
  --col-text:      #1A1A1A;
  --col-text2:     #555555;
  --col-text3:     #888888;

  /* Accent */
  --col-accent:       #2563EB;
  --col-accent-light: #EFF6FF;
  --col-accent-hover: #1D4ED8;

  /* Grid */
  --col-header-bg:    #F0F0F0;
  --col-row-odd:      #FAFAFA;
  --col-row-even:     #FFFFFF;
  --col-row-hover:    #F0F5FF;
  --col-row-selected: #DBEAFE;
  --col-row-num:      #F5F5F5;
  --col-cell-border:  #E8E8E8;

  /* Heights */
  --h-titlebar:   38px;
  --h-toolbar:    44px;
  --h-tab:        34px;
  --h-fileinfo:   28px;
  --h-searchbar:  38px;
  --h-header-row: 34px;
  --h-data-row:   28px;
  --h-statusbar:  24px;
  --w-row-num:    52px;
}
```

### 6.5 AG-Grid カスタム設定

```typescript
// components/DataGrid/DataGrid.tsx

const columnDefs = useMemo(() => [
  {
    // 行番号列（固定）
    headerName: '#',
    field: '__rowNum',
    width: 52,
    pinned: 'left' as const,
    resizable: false,
    sortable: false,
    cellStyle: {
      fontFamily: 'var(--font-mono)',
      fontSize: '11px',
      color: 'var(--col-text3)',
      backgroundColor: 'var(--col-row-num)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-end',
      paddingRight: '10px',
    },
  },
  // データ列
  ...headers.map((header, idx) => ({
    headerName: header,
    field: `col_${idx}`,
    width: 150,
    resizable: true,
    sortable: false,       // Phase 2 で true に変更
    filter: false,         // Phase 2 で有効化
    cellStyle: {
      fontFamily: 'var(--font-mono)',
      fontSize: '12px',
    },
    headerClass: 'csv-col-header',
  })),
], [headers]);

const defaultColDef = {
  resizable: true,
  sortable: false,
};

// AG-Grid Infinite Row Model 設定
<AgGridReact
  rowModelType="infinite"
  datasource={datasource}
  cacheBlockSize={200}           // 一度に取得する行数
  cacheOverflowSize={2}
  maxConcurrentDatasourceRequests={1}
  infiniteInitialRowCount={totalRows}
  maxBlocksInCache={20}
  rowHeight={28}
  headerHeight={34}
  columnDefs={columnDefs}
  defaultColDef={defaultColDef}
  suppressCellFocus={true}
  enableCellTextSelection={true}
  onBodyScroll={onScrollSave}
/>
```

### 6.6 v0 プロンプト（コンポーネント生成）

#### TabBar コンポーネント

```
Create a macOS-style tab bar component for a CSV viewer with multiple file support.

Requirements:
- Tabs are bottom-aligned, compact (height: 28px active, 26px inactive)
- Active tab: white background, border on top/sides, no bottom border
- Inactive tab: light gray background, hover state slightly lighter
- Each tab shows: filename (truncated with ellipsis), optional blue dot for "modified" state, close button (✕)
- Close button only visible on hover or active tab
- Tab max-width: 200px, min-width: 80px
- [+] button at the end to open new file
- Horizontal scroll when many tabs overflow
- Custom thin scrollbar

Props:
interface TabBarProps {
  tabs: { id: string; filename: string; isModified?: boolean }[]
  activeTabId: string | null
  onSwitch: (id: string) => void
  onClose:  (id: string) => void
  onAdd:    () => void
}

Style: macOS Big Sur aesthetic, system-ui font, no external libraries.
Use Tailwind CSS utility classes only.
Export as TabBar component.
```

#### DataGrid コンポーネント

```
Create an AG-Grid wrapper component for a CSV viewer with these specs:

- Row model: Infinite (virtual scrolling, supports 100k+ rows)
- First column: row number (#), pinned left, 52px width, monospace font, right-aligned, gray background
- Data columns: 150px default width, resizable, monospace cell font
- Row height: 28px, header height: 34px
- Zebra striping via AG-Grid theme
- Row hover highlight: light blue (#F0F5FF)
- Custom AG-Grid theme matching these CSS vars:
    --header-bg: #F0F0F0
    --row-border: #E8E8E8
    --accent: #2563EB

Props:
interface DataGridProps {
  headers: string[]
  totalRows: number
  tabId: string
  searchHits: { row: number; column: number }[]
  currentHitIndex: number
  onScrollSave: (offset: number) => void
  initialScrollOffset?: number
}

The datasource calls: invoke<DataRange>('get_csv_data_range', { tabId, startRow, endRow })

Export as DataGrid component with TypeScript.
```

---

## 7. データモデル

### TypeScript型定義（src/types/index.ts）

```typescript
export interface CsvTab {
  id: string
  filePath: string
  filename: string
  metadata: FileMetadata | null
  isLoading: boolean
  scrollOffset: number
  searchQuery: string
  searchHits: SearchHit[]
  searchHitIndex: number
}

export interface FileMetadata {
  filename: string
  filePath: string
  fileSize: number
  totalRows: number
  totalColumns: number
  encoding: string
  delimiter: string
  headers: string[]
}

export interface DataRange {
  rows: string[][]
  totalRows: number
}

export interface SearchHit {
  row: number
  column: number
}

export interface SearchResponse {
  hits: SearchHit[]
  totalCount: number
}
```

### Rust型定義（src-tauri/src/types.rs）

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadata {
    pub filename: String,
    pub file_path: String,
    pub file_size: u64,
    pub total_rows: usize,
    pub total_columns: usize,
    pub encoding: String,
    pub delimiter: char,
    pub headers: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DataRange {
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchHit {
    pub row: usize,
    pub column: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    pub total_count: usize,
}

// エラー型
#[derive(Debug, thiserror::Error, Serialize)]
pub enum CsvError {
    #[error("File not found: {0}")]
    FileNotFound(String),
    #[error("Encoding detection failed")]
    EncodingError,
    #[error("CSV parse error: {0}")]
    ParseError(String),
    #[error("No tab found: {0}")]
    TabNotFound(String),
    #[error("DuckDB error: {0}")]
    DuckDbError(String),
}
```

---

## 8. Tauri IPC API設計

### コマンド一覧

| コマンド | 入力 | 出力 | 説明 |
|---------|------|------|------|
| `open_csv_file` | `path: String, tab_id: String` | `FileMetadata` | ファイル読み込み・DuckDB登録 |
| `get_csv_data_range` | `tab_id, start_row, end_row` | `DataRange` | 行範囲データ取得 |
| `search_csv` | `tab_id, query: String` | `SearchResponse` | 全データ検索 |
| `close_tab` | `tab_id: String` | `()` | DuckDB接続のクリーンアップ |

### フロントエンド呼び出し例

```typescript
import { invoke } from '@tauri-apps/api/core';
import { open }   from '@tauri-apps/plugin-dialog';

// ファイルを開く
const openFile = async (tabId: string) => {
  const selected = await open({
    multiple: false,
    filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }],
  });
  if (!selected) return;

  const metadata = await invoke<FileMetadata>('open_csv_file', {
    path: selected,
    tabId,
  });
  return metadata;
};

// データ範囲取得（AG-Grid の datasource から呼ぶ）
const fetchRange = async (tabId: string, startRow: number, endRow: number) => {
  return await invoke<DataRange>('get_csv_data_range', {
    tabId,
    startRow,
    endRow,
  });
};

// 検索
const search = async (tabId: string, query: string) => {
  return await invoke<SearchResponse>('search_csv', { tabId, query });
};

// タブを閉じる
const closeTab = async (tabId: string) => {
  await invoke('close_tab', { tabId });
};
```

---

## 9. DuckDB設計

### なぜ DuckDB を使うか

| 処理 | `Vec<Vec<String>>` | DuckDB |
|------|--------------------|--------|
| 読み込み（10万行） | 2〜3秒 | 1〜2秒 |
| メモリ（10万行） | 80〜100MB | 30〜50MB |
| 列ソート（Phase 2） | 0.5〜1秒（手実装） | 0.05秒（SQL） |
| フィルタリング（Phase 2） | 0.3〜0.5秒 | 0.01秒 |
| 検索 | 0.5〜1秒 | 0.1〜0.2秒 |

**列指向ストレージ**により特定列のみ読み込み可能なため、ソート・フィルタを Phase 2 で追加する際もSQL一行で対応できる。

### State 設計（複数タブ対応）

```rust
// src-tauri/src/state.rs

use duckdb::Connection;
use std::collections::HashMap;
use std::sync::Mutex;

pub struct DuckDBState {
    // tab_id → DuckDB Connection
    pub connections: Mutex<HashMap<String, Connection>>,
}

impl DuckDBState {
    pub fn new() -> Self {
        DuckDBState {
            connections: Mutex::new(HashMap::new()),
        }
    }
}
```

### main.rs への登録

```rust
fn main() {
    tauri::Builder::default()
        .manage(DuckDBState::new())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::open_csv_file,
            commands::get_csv_data_range,
            commands::search_csv,
            commands::close_tab,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### open_csv_file コマンド

```rust
#[tauri::command]
pub async fn open_csv_file(
    path: String,
    tab_id: String,
    state: tauri::State<'_, DuckDBState>,
) -> Result<FileMetadata, String> {

    // 1. エンコーディング検出
    let raw = std::fs::read(&path).map_err(|e| e.to_string())?;
    let encoding = detect_encoding(&raw);

    // 2. 区切り文字検出（先頭 8KB をサンプリング）
    let (decoded, _, _) = encoding.decode(&raw);
    let delimiter = detect_delimiter(&decoded);

    // 3. DuckDB接続（タブ別インメモリ）
    let conn = Connection::open_in_memory()
        .map_err(|e| e.to_string())?;

    let delim_str = match delimiter {
        '\t' => "\\t".to_string(),
        c    => c.to_string(),
    };

    // 4. CSVをDuckDBにロード
    conn.execute_batch(&format!(
        "CREATE TABLE csv_data AS
         SELECT * FROM read_csv_auto('{}', delim='{}', header=true, ignore_errors=true)",
        path.replace('\'', "''"), delim_str
    )).map_err(|e| format!("DuckDB load error: {}", e))?;

    // 5. メタデータ取得
    let total_rows: usize = conn
        .query_row("SELECT COUNT(*) FROM csv_data", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let headers: Vec<String> = conn
        .prepare("SELECT column_name FROM (DESCRIBE csv_data)")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let total_columns = headers.len();
    let file_size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let filename = std::path::Path::new(&path)
        .file_name().and_then(|n| n.to_str())
        .unwrap_or("unknown.csv").to_string();

    // 6. 接続を保存
    state.connections.lock().unwrap().insert(tab_id, conn);

    Ok(FileMetadata {
        filename, file_path: path, file_size,
        total_rows, total_columns,
        encoding: encoding.name().to_string(),
        delimiter,
        headers,
    })
}
```

### get_csv_data_range コマンド

```rust
#[tauri::command]
pub fn get_csv_data_range(
    tab_id: String,
    start_row: usize,
    end_row: usize,
    state: tauri::State<'_, DuckDBState>,
) -> Result<DataRange, String> {

    let connections = state.connections.lock().unwrap();
    let conn = connections.get(&tab_id)
        .ok_or_else(|| format!("Tab not found: {}", tab_id))?;

    let limit  = end_row.saturating_sub(start_row).min(500); // 最大500行/回
    let offset = start_row;

    let total_rows: usize = conn
        .query_row("SELECT COUNT(*) FROM csv_data", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(&format!("SELECT * FROM csv_data LIMIT {} OFFSET {}", limit, offset))
        .map_err(|e| e.to_string())?;

    let col_count = stmt.column_count();

    let rows: Vec<Vec<String>> = stmt
        .query_map([], |row| {
            (0..col_count)
                .map(|i| row.get::<_, String>(i).unwrap_or_default())
                .collect::<Vec<_>>()
                .pipe(Ok)  // collect して Ok に包む
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(DataRange { rows, total_rows })
}
```

### search_csv コマンド

```rust
#[tauri::command]
pub fn search_csv(
    tab_id: String,
    query: String,
    state: tauri::State<'_, DuckDBState>,
) -> Result<SearchResponse, String> {

    if query.is_empty() {
        return Ok(SearchResponse { hits: vec![], total_count: 0 });
    }

    let connections = state.connections.lock().unwrap();
    let conn = connections.get(&tab_id)
        .ok_or_else(|| format!("Tab not found: {}", tab_id))?;

    // 全カラム名を取得
    let headers: Vec<String> = conn
        .prepare("SELECT column_name FROM (DESCRIBE csv_data)")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // 各カラムを LIKE 検索、ヒット行番号を取得
    let mut hits: Vec<SearchHit> = Vec::new();
    let escaped = query.replace('\'', "''").replace('%', "\\%").replace('_', "\\_");

    for (col_idx, col_name) in headers.iter().enumerate() {
        let sql = format!(
            "SELECT row_number() OVER () - 1 AS rn
             FROM csv_data
             WHERE CAST(\"{col_name}\" AS VARCHAR) LIKE '%{escaped}%' ESCAPE '\\'
             LIMIT 10000"
        );

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let row_hits: Vec<usize> = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        for row in row_hits {
            hits.push(SearchHit { row, column: col_idx });
        }
    }

    // 行番号でソート
    hits.sort_by_key(|h| (h.row, h.column));
    hits.truncate(10_000);

    let total_count = hits.len();
    Ok(SearchResponse { hits, total_count })
}
```

### close_tab コマンド

```rust
#[tauri::command]
pub fn close_tab(
    tab_id: String,
    state: tauri::State<'_, DuckDBState>,
) -> Result<(), String> {
    state.connections.lock().unwrap().remove(&tab_id);
    // Connection が Drop されるとDuckDBのリソースが解放される
    Ok(())
}
```

### エンコーディング検出

```rust
// src-tauri/src/encoding.rs

use chardetng::EncodingDetector;
use encoding_rs::{Encoding, UTF_8, SHIFT_JIS, EUC_JP};

pub fn detect_encoding(bytes: &[u8]) -> &'static Encoding {
    // BOM チェック（UTF-8 BOM）
    if bytes.starts_with(b"\xEF\xBB\xBF") {
        return UTF_8;
    }

    let mut detector = EncodingDetector::new();
    let sample_size = bytes.len().min(16_384); // 先頭16KB
    detector.feed(&bytes[..sample_size], bytes.len() <= sample_size);

    let enc = detector.guess(None, true);

    // サポート対象のみ返す
    match enc {
        e if e == SHIFT_JIS => SHIFT_JIS,
        e if e == EUC_JP    => EUC_JP,
        _                   => UTF_8,
    }
}
```

### 区切り文字検出

```rust
// src-tauri/src/delimiter.rs

pub fn detect_delimiter(content: &str) -> char {
    let candidates = [',', '\t', ';'];
    let lines: Vec<&str> = content.lines().take(20).collect();

    if lines.is_empty() {
        return ',';
    }

    // 各区切り文字の「出現数の一貫性」を評価
    let best = candidates.iter().max_by_key(|&&delim| {
        let counts: Vec<usize> = lines.iter()
            .map(|l| l.matches(delim).count())
            .collect();

        if counts.iter().all(|&c| c == 0) {
            return 0;
        }

        // 最頻値 × (ばらつきが小さいほど高スコア)
        let max = *counts.iter().max().unwrap_or(&0);
        let variance: usize = counts.iter()
            .map(|&c| (c as isize - max as isize).unsigned_abs())
            .sum();

        if variance == 0 { max * 100 } else { max * 100 / (variance + 1) }
    });

    *best.unwrap_or(&',')
}
```

---

## 10. フロントエンド実装

### App.tsx（状態管理のルート）

```typescript
import { useReducer, useEffect, useCallback } from 'react';
import { appReducer, initialState } from './store/appReducer';
import { TitleBar }   from './components/TitleBar';
import { Toolbar }    from './components/Toolbar';
import { TabBar }     from './components/TabBar/TabBar';
import { FileInfoBar } from './components/FileInfoBar';
import { SearchBar }  from './components/SearchBar';
import { DataGrid }   from './components/DataGrid/DataGrid';
import { EmptyState } from './components/EmptyState';
import { StatusBar }  from './components/StatusBar';
import { useFileOpen } from './hooks/useFileOpen';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { v4 as uuid } from 'uuid';

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const { openFile } = useFileOpen(dispatch);

  const activeTab = state.tabs.find(t => t.id === state.activeTabId) ?? null;

  // キーボードショートカット
  useKeyboardShortcuts({
    onOpen:        () => openFile(uuid()),
    onSearch:      () => dispatch({ type: 'SEARCH_OPEN' }),
    onSearchClose: () => dispatch({ type: 'SEARCH_CLOSE' }),
    onCloseTab:    () => activeTab && dispatch({ type: 'TAB_CLOSE', payload: { tabId: activeTab.id } }),
  });

  return (
    <div className="app-shell">
      <TitleBar filename={activeTab?.filename ?? null} />

      <Toolbar
        onOpen={() => openFile(uuid())}
        onSearch={() => dispatch({ type: 'SEARCH_OPEN' })}
        hasFile={!!activeTab}
      />

      <TabBar
        tabs={state.tabs.map(t => ({ id: t.id, filename: t.filename, isModified: false }))}
        activeTabId={state.activeTabId}
        onSwitch={id => dispatch({ type: 'TAB_SWITCH', payload: { tabId: id } })}
        onClose={id => {
          dispatch({ type: 'TAB_CLOSE', payload: { tabId: id } });
          // DuckDB 接続を解放
          invoke('close_tab', { tabId: id });
        }}
        onAdd={() => openFile(uuid())}
      />

      {activeTab?.metadata && (
        <FileInfoBar metadata={activeTab.metadata} />
      )}

      {state.isSearchOpen && activeTab && (
        <SearchBar
          tabId={activeTab.id}
          query={activeTab.searchQuery}
          hits={activeTab.searchHits}
          currentIndex={activeTab.searchHitIndex}
          dispatch={dispatch}
          onClose={() => dispatch({ type: 'SEARCH_CLOSE' })}
        />
      )}

      {activeTab?.metadata ? (
        <DataGrid
          key={activeTab.id}           // タブ切替でインスタンスを再生成
          headers={activeTab.metadata.headers}
          totalRows={activeTab.metadata.totalRows}
          tabId={activeTab.id}
          searchHits={activeTab.searchHits}
          currentHitIndex={activeTab.searchHitIndex}
          initialScrollOffset={activeTab.scrollOffset}
          onScrollSave={offset =>
            dispatch({ type: 'TAB_SCROLL_SAVE', payload: { tabId: activeTab.id, offset } })
          }
        />
      ) : (
        <EmptyState
          onOpen={() => openFile(uuid())}
          onDrop={path => openFile(uuid(), path)}
        />
      )}

      <StatusBar
        activeTab={activeTab}
        tabCount={state.tabs.length}
      />
    </div>
  );
}
```

### useFileOpen.ts

```typescript
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import type { FileMetadata, AppAction } from '../types';

export const useFileOpen = (dispatch: React.Dispatch<AppAction>) => {
  const openFile = async (tabId: string, forcePath?: string) => {
    const path = forcePath ?? await open({
      multiple: false,
      filters: [{ name: 'CSV Files', extensions: ['csv', 'tsv', 'txt'] }],
    });

    if (!path || typeof path !== 'string') return;

    // タブを追加してローディング状態に
    dispatch({
      type: 'TAB_ADD',
      payload: {
        id: tabId,
        filePath: path,
        filename: path.split('/').pop() ?? 'file.csv',
        metadata: null,
        isLoading: true,
        scrollOffset: 0,
        searchQuery: '',
        searchHits: [],
        searchHitIndex: 0,
      },
    });

    try {
      const metadata = await invoke<FileMetadata>('open_csv_file', { path, tabId });
      dispatch({ type: 'TAB_METADATA_LOADED', payload: { tabId, metadata } });
    } catch (err) {
      console.error('Failed to open file:', err);
      // TODO: エラートーストを表示
      dispatch({ type: 'TAB_CLOSE', payload: { tabId } });
    }
  };

  return { openFile };
};
```

### datasource.ts（AG-Grid Infinite）

```typescript
import { invoke } from '@tauri-apps/api/core';
import type { IDatasource, IGetRowsParams } from 'ag-grid-community';
import type { DataRange } from '../../types';

export const createDatasource = (tabId: string): IDatasource => ({
  getRows: async (params: IGetRowsParams) => {
    try {
      const result = await invoke<DataRange>('get_csv_data_range', {
        tabId,
        startRow: params.startRow,
        endRow: params.endRow,
      });

      const rowData = result.rows.map((row, idx) => ({
        __rowNum: params.startRow + idx + 1,
        ...row.reduce<Record<string, string>>((acc, cell, ci) => {
          acc[`col_${ci}`] = cell;
          return acc;
        }, {}),
      }));

      params.successCallback(rowData, result.totalRows);
    } catch (err) {
      console.error('Datasource error:', err);
      params.failCallback();
    }
  },
});
```

---

## 11. バックエンド実装

### ディレクトリ構成（Rust）

```
src-tauri/src/
├── main.rs          # エントリポイント
├── lib.rs           # Tauri Builder 設定
├── state.rs         # DuckDBState
├── types.rs         # 共通型（FileMetadata, DataRange, etc.）
├── commands/
│   ├── mod.rs
│   ├── file.rs      # open_csv_file, close_tab
│   ├── data.rs      # get_csv_data_range
│   └── search.rs    # search_csv
└── csv/
    ├── mod.rs
    ├── encoding.rs  # detect_encoding
    └── delimiter.rs # detect_delimiter
```

### エラーの統一（Tauriへの変換）

```rust
// types.rs
impl From<CsvError> for String {
    fn from(err: CsvError) -> String {
        err.to_string()
    }
}

// duckdb::Error → String
impl From<duckdb::Error> for CsvError {
    fn from(e: duckdb::Error) -> Self {
        CsvError::DuckDbError(e.to_string())
    }
}
```

---

## 12. 実装時の懸念点・対策

### ① Mutex ロックの最小化

**問題**: `get_csv_data_range` が頻繁に呼ばれるためロック競合が起きやすい。

```rust
// NG: ロックしたまま重い処理
let conn = state.connections.lock().unwrap();
let rows = heavy_query(conn); // ← ロック長時間保持

// OK: RwLockで読み取り共有
pub struct DuckDBState {
    pub connections: std::sync::RwLock<HashMap<String, Connection>>,
}
// read() は複数スレッドから同時取得可能
let connections = state.connections.read().unwrap();
```

ただし DuckDB の `Connection` 自体が `Send` でない場合があるため、`Arc<Mutex<Connection>>` で各接続を包む：

```rust
pub connections: Mutex<HashMap<String, Arc<Mutex<Connection>>>>
```

### ② AG-Grid の同時リクエスト制限

**問題**: 高速スクロールで大量の `getRows` が発火する。

```typescript
// datasource.ts にデバウンスとキャンセル機構を追加
const createDatasource = (tabId: string): IDatasource => {
  let latestReqId = 0;

  return {
    getRows: async (params) => {
      const reqId = ++latestReqId;

      const result = await invoke<DataRange>('get_csv_data_range', { ... });

      if (reqId !== latestReqId) return; // 古いリクエストは破棄
      params.successCallback(rowData, result.totalRows);
    },
  };
};

// AG-Grid 設定で同時リクエスト数を制限
maxConcurrentDatasourceRequests={1}
```

### ③ エンコーディング検出の精度（Shift_JIS vs EUC-JP）

**問題**: `chardetng` は日本語エンコーディングを混同することがある。

```rust
// 検出が曖昧な場合、ユーザーに手動選択を促す
pub fn detect_encoding_with_confidence(bytes: &[u8]) -> (&'static Encoding, bool) {
    // ... 検出処理 ...
    let high_confidence = /* 判定ロジック */;
    (encoding, high_confidence)
}

// フロントエンドで低信頼度の場合にダイアログ表示
if (!metadata.encodingConfident) {
  showEncodingSelector(tabId); // UTF-8 / Shift_JIS / EUC-JP を選択
}
```

### ④ macOS サンドボックス・ファイルアクセス権限

```json
// tauri.conf.json
{
  "plugins": {
    "fs": {
      "scope": ["$HOME/**", "$DESKTOP/**", "$DOCUMENT/**"]
    }
  }
}
```

### ⑤ タブを閉じる際の DuckDB クリーンアップ

```typescript
// タブを閉じるとき必ず invoke('close_tab') を呼ぶ
// ウィンドウ全体を閉じるときも同様
import { onCleanup } from 'solid-js'; // React の useEffect cleanup
useEffect(() => {
  return () => {
    tabs.forEach(tab => invoke('close_tab', { tabId: tab.id }));
  };
}, []);
```

### ⑥ Tauri 2.x 固有の注意点

```typescript
// Tauri v1 との主な変更点
// ❌ v1: import { invoke } from '@tauri-apps/api/tauri'
// ✅ v2: import { invoke } from '@tauri-apps/api/core'

// ❌ v1: import { open } from '@tauri-apps/api/dialog'
// ✅ v2: import { open } from '@tauri-apps/plugin-dialog'
//        + Cargo.toml に tauri-plugin-dialog を追加
//        + main.rs で .plugin(tauri_plugin_dialog::init()) を登録

// ドラッグ&ドロップ
// v2 では onFileDropEvent を使用
import { getCurrentWebview } from '@tauri-apps/api/webview';
getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type === 'drop') {
    event.payload.paths.forEach(path => openFile(uuid(), path));
  }
});
```

---

## 13. 開発フェーズ

### Phase 1.1: MVP（1週間）
- [ ] Tauri 2 プロジェクト初期化
- [ ] DuckDB 接続・CSVロード（UTF-8 / カンマのみ）
- [ ] AG-Grid でシンプルなテーブル表示
- [ ] ファイル選択ダイアログ
- [ ] macOS でのビルド・動作確認

### Phase 1.2: 複数タブ（1週間）
- [ ] タブバー UI 実装
- [ ] `DuckDBState` を `HashMap<tab_id, Connection>` に拡張
- [ ] タブ追加・切替・閉じる
- [ ] タブ別スクロール位置の保存・復元

### Phase 1.3: パフォーマンス（1週間）
- [ ] AG-Grid Infinite Row Model の実装
- [ ] 10万行でのパフォーマンス計測（目標: 60fps）
- [ ] `maxConcurrentDatasourceRequests` チューニング
- [ ] メモリ使用量の確認（目標: 200MB以内）

### Phase 1.4: エンコーディング・区切り文字（1週間）
- [ ] `chardetng` によるエンコーディング自動検出
- [ ] Shift_JIS / EUC-JP 対応
- [ ] 区切り文字自動検出（タブ・セミコロン）
- [ ] 低信頼度時の手動選択UI

### Phase 1.5: UX 仕上げ（1週間）
- [ ] ドラッグ&ドロップ（Tauri 2 API）
- [ ] インライン検索バー（⌘F）
- [ ] キーボードショートカット全実装
- [ ] FileInfoBar
- [ ] StatusBar（行範囲・セル座標）
- [ ] エラートースト

### Phase 1.6: テスト・リリース（1週間）
- [ ] Rust ユニットテスト（エンコーディング・区切り文字・クエリ）
- [ ] 各種CSVでの動作確認
- [ ] Universal Binary ビルド（Intel + Apple Silicon）
- [ ] .dmg インストーラー作成

**Phase 1 合計: 6週間**

---

## 14. プロジェクトセットアップ

### 初期化

```bash
# Tauri 2 プロジェクト作成
npm create tauri-app@latest csv-viewer
# → TypeScript / React / npm を選択

cd csv-viewer
npm install

# 追加依存
npm install ag-grid-community ag-grid-react lucide-react uuid
npm install -D @types/uuid

# TailwindCSS
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

### Cargo.toml 設定

```toml
[dependencies]
tauri                = { version = "2.0", features = [] }
tauri-plugin-dialog  = "2.0"
serde                = { version = "1.0", features = ["derive"] }
serde_json           = "1.0"
duckdb               = { version = "0.10", features = ["bundled"] }
csv                  = "1.3"
encoding_rs          = "0.8"
chardetng            = "0.1"
thiserror            = "1.0"
uuid                 = { version = "1.6", features = ["v4"] }
```

### ディレクトリ構成（最終）

```
csv-viewer/
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   ├── index.css          # Tailwind + デザイントークン
│   ├── components/
│   │   ├── TitleBar.tsx
│   │   ├── Toolbar.tsx
│   │   ├── TabBar/
│   │   │   ├── TabBar.tsx
│   │   │   └── Tab.tsx
│   │   ├── FileInfoBar.tsx
│   │   ├── SearchBar.tsx
│   │   ├── DataGrid/
│   │   │   ├── DataGrid.tsx
│   │   │   └── datasource.ts
│   │   ├── EmptyState.tsx
│   │   └── StatusBar.tsx
│   ├── hooks/
│   │   ├── useFileOpen.ts
│   │   ├── useTabManager.ts
│   │   ├── useSearch.ts
│   │   └── useKeyboardShortcuts.ts
│   ├── store/
│   │   └── appReducer.ts
│   └── types/
│       └── index.ts
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── state.rs
│   │   ├── types.rs
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── file.rs
│   │   │   ├── data.rs
│   │   │   └── search.rs
│   │   └── csv/
│   │       ├── mod.rs
│   │       ├── encoding.rs
│   │       └── delimiter.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
└── test-data/
    ├── utf8_100k.csv
    ├── sjis_sample.csv
    ├── tab_delimited.tsv
    └── edge_cases.csv
```

### 開発・ビルドコマンド

```bash
# 開発
npm run tauri dev

# ビルド（Universal Binary）
npm run tauri build -- --target universal-apple-darwin

# Intel のみ
npm run tauri build -- --target x86_64-apple-darwin

# Apple Silicon のみ
npm run tauri build -- --target aarch64-apple-darwin
```

---

## 15. 参考OSSリポジトリ

| プロジェクト | URL | 参考箇所 |
|------------|-----|---------|
| **Duckling** ★最重要 | https://github.com/l1xnan/duckling | Tauri + DuckDB の IPC 実装、エンコーディング処理 |
| csv-grid-viewer | https://github.com/sheepla/csv-grid-viewer | AG-Grid + Tauri の組み合わせ |
| SmoothCSV v3 | https://github.com/kohii/smoothcsv3 | UIデザイン・機能設計（コード非公開）|
| SmoothCSV v2 | https://github.com/kohii/smoothcsv2 | 旧バージョン（Java）、機能参考 |
| Tad | https://github.com/antonycourtney/tad | Electron版・DuckDB活用・大容量対応設計 |
| csViewer | https://github.com/TGiulio/csViewer | Tauri基礎実装（シンプル） |

### Duckling からの削除対象

```
❌ 削除
├── Parquet ファイル対応
├── PostgreSQL / MySQL / ClickHouse 接続
├── SQLite 接続 UI
├── DuckDB SQL コンソール
├── データベースブラウザサイドバー
└── テーブル一覧・スキーマビュー

✅ 残す（参考にする）
├── DuckDB 接続管理パターン
├── CSV read_csv_auto の使い方
├── エンコーディング検出処理
├── Tauri IPC コマンド構造
└── AG-Grid のデータソース実装
```

---

## 付録: テストデータ生成

```python
# generate_test_data.py
import csv, random, string

def gen(filename, rows, encoding='utf-8', delimiter=','):
    headers = ['id','name','city','category','value','date']
    cities  = ['Tokyo','Osaka','Nagoya','Fukuoka','Sapporo']
    cats    = ['A','B','C','D']

    with open(filename, 'w', newline='', encoding=encoding) as f:
        w = csv.writer(f, delimiter=delimiter)
        w.writerow(headers)
        for i in range(1, rows+1):
            w.writerow([
                i,
                ''.join(random.choices(string.ascii_letters, k=8)),
                random.choice(cities),
                random.choice(cats),
                round(random.uniform(100, 10000), 2),
                f'2024-{random.randint(1,12):02d}-{random.randint(1,28):02d}',
            ])
    print(f'✓ {filename}: {rows} rows, {encoding}, delimiter={repr(delimiter)}')

if __name__ == '__main__':
    gen('test-data/utf8_100k.csv',    100_000)
    gen('test-data/sjis_sample.csv',   10_000, encoding='shift_jis')
    gen('test-data/tab_delimited.tsv', 10_000, delimiter='\t')
    gen('test-data/small.csv',            100)
```

---

**変更履歴**:
- v1.0 (2026/02): 初版作成（全会話内容を集約）
