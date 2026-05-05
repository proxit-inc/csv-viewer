interface LoadingStateProps {
  filename: string;
}

export function LoadingState({ filename }: LoadingStateProps) {
  return (
    <div
      className="flex flex-col items-center justify-center flex-1 gap-3"
      style={{ color: "var(--col-text3)" }}
    >
      <div
        className="w-6 h-6 rounded-full border-2 animate-spin"
        style={{
          borderColor: "var(--col-border)",
          borderTopColor: "var(--col-accent)",
        }}
      />
      <p className="text-sm" style={{ color: "var(--col-text2)" }}>
        Loading {filename}…
      </p>
    </div>
  );
}
