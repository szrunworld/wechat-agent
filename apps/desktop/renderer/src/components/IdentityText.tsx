// Names, ids and message bodies are never truncated: a cut-off identity is a wrong identity.
export function IdentityText({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <span className={`identity ${className}`}>{children}</span>;
}
