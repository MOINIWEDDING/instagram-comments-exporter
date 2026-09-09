export interface CommentItem {
  videoUrl: string;
  shortcode: string;
  commentId: string;
  parentCommentId: string | null;
  username: string;
  text: string;
  timestamp: number | null;
  likeCount: number | null;
}

export interface ScrapeResult {
  url: string;
  shortcode: string | null;
  ok: boolean;
  error?: string;
  mode: "authenticated" | "anonymous" | "none";
  comments: CommentItem[];
}
