export interface CsvTab {
  id: string;
  filePath: string;
  filename: string;
  metadata: FileMetadata | null;
  isLoading: boolean;
  scrollOffset: number;
  searchQuery: string;
  searchHits: SearchHit[];
  searchHitIndex: number;
}

export interface FileMetadata {
  filename: string;
  filePath: string;
  fileSize: number;
  totalRows: number;
  totalColumns: number;
  encoding: string;
  delimiter: string;
  headers: string[];
}

export interface DataRange {
  rows: string[][];
  totalRows: number;
}

export interface SearchHit {
  row: number;
  column: number;
}

export interface SearchResponse {
  hits: SearchHit[];
  totalCount: number;
}

export interface AppState {
  tabs: CsvTab[];
  activeTabId: string | null;
  isSearchOpen: boolean;
}

export type AppAction =
  | { type: "TAB_ADD"; payload: CsvTab }
  | { type: "TAB_CLOSE"; payload: { tabId: string } }
  | { type: "TAB_SWITCH"; payload: { tabId: string } }
  | { type: "TAB_METADATA_LOADED"; payload: { tabId: string; metadata: FileMetadata } }
  | { type: "TAB_SCROLL_SAVE"; payload: { tabId: string; offset: number } }
  | { type: "SEARCH_OPEN" }
  | { type: "SEARCH_CLOSE" }
  | { type: "SEARCH_UPDATE"; payload: { tabId: string; query: string; hits: SearchHit[] } }
  | { type: "SEARCH_NAVIGATE"; payload: { tabId: string; index: number } };
