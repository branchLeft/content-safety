export class DeadlineExceeded extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not settle within ${String(ms)}ms`);
    this.name = 'DeadlineExceeded';
  }
}

/** Rejects if `work` has not settled within `ms`, whether or not `work` ever does. */
export async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(what, ms)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function assertBudget(name: string, ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new RangeError(`${name} must be a positive, finite number of milliseconds`);
  }
  return ms;
}
