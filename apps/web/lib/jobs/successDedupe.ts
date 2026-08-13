/**
 * 成功任务去重控制器（纯逻辑，便于测试）。
 *
 * JobsPanel 中同一 succeeded job 可能被多次轮询命中（jobs 数组更新触发 effect）。
 * 守卫分两个集合：
 *   - inflight：getJob 在途（防止并发重复请求 / 重复落节点）
 *   - completed：getJob 成功拿到 outputs 并已回调（最终去重）
 * getJob 失败时仅 release（不 complete），允许后续轮询重试。
 */
export function createSucceededJobGuard() {
  const completed = new Set<string>();
  const inflight = new Set<string>();

  return {
    /** 该 job 是否应该开始处理（未完成且不在途） */
    shouldProcess(jobId: string): boolean {
      return !completed.has(jobId) && !inflight.has(jobId);
    },
    /** 标记 getJob 在途 */
    claim(jobId: string): void {
      inflight.add(jobId);
    },
    /** getJob 失败/结束：释放在途，允许重试 */
    release(jobId: string): void {
      inflight.delete(jobId);
    },
    /** getJob 成功并回调后：登记完成，永久去重 */
    complete(jobId: string): void {
      inflight.delete(jobId);
      completed.add(jobId);
    },
    isCompleted(jobId: string): boolean {
      return completed.has(jobId);
    },
    isInflight(jobId: string): boolean {
      return inflight.has(jobId);
    },
  };
}

export type SucceededJobGuard = ReturnType<typeof createSucceededJobGuard>;
