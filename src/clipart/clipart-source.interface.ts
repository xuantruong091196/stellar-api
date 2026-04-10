export interface ClipartItem {
  id: string;
  title: string;
  previewUrl: string; // Small preview for browsing
  downloadUrl: string; // Full resolution for canvas
  source: string; // 'freepik' | 'bundled'
  attribution?: string;
}

export interface ClipartSearchResult {
  items: ClipartItem[];
  total: number;
  page: number;
  hasMore: boolean;
}

export interface IClipartSource {
  readonly sourceName: string;
  search(query: string, page?: number, limit?: number): Promise<ClipartSearchResult>;
  getDownloadUrl(id: string): Promise<string>;
}
