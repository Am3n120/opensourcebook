/** What URL verification reports about a generated output's links and media. */
export interface URLCheck {
  url: string;
  ok: boolean;
  status?: number;
  method?: "HEAD" | "GET" | "oEmbed";
  contentType?: string;
  error?: string;
}

export interface URLVerificationReport {
  checked: URLCheck[];
  failures: URLCheck[];
  warnings: string[];
  mediaChecked: number;
  chartErrors: string[];
  valid: boolean;
}
