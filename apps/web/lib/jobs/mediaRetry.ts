/**
 * 媒体签名 URL 重试预算（纯函数，便于测试）。
 *
 * 规则：媒体加载失败后重新签名的次数有上限（MEDIA_MAX_RETRIES）；
 * 重新签名成功不会重置同一轮媒体失败次数（避免 URL 持续失效时无限重签）。
 * 仅在切换 assetId（组件 key 变化重建）或用户手动点击"重试"时重置预算。
 */
export const MEDIA_MAX_RETRIES = 3;

/** 是否已达重试上限（attempt 为已发生的重试次数） */
export function isMediaRetryExhausted(attempt: number): boolean {
  return attempt >= MEDIA_MAX_RETRIES;
}

/** 下一次重试前的退避延迟（ms）；1s/2s/…，上限 5s */
export function nextMediaRetryDelay(attempt: number): number {
  return Math.min(1000 * attempt, 5000);
}
