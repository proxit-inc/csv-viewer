import { useCallback, useRef } from "react";

export function useDebounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  delayMs: number
): T {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  return useCallback(
    ((...args: Parameters<T>) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => fn(...args), delayMs);
    }) as T,
    [fn, delayMs]
  );
}
