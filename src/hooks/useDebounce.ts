import { useCallback, useEffect, useRef } from "react";

export function useDebounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  delayMs: number
): T {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Cancel any pending timer when the component unmounts so a stale
  // delayed callback cannot fire after the component is gone.
  useEffect(() => () => clearTimeout(timer.current), []);

  return useCallback(
    ((...args: Parameters<T>) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => fn(...args), delayMs);
    }) as T,
    [fn, delayMs]
  );
}
