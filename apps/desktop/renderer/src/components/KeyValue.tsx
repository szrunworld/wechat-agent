export function KeyValue({ rows }: { rows: { k: string; v: React.ReactNode }[] }) {
  return (
    <dl className="kv">
      {rows.map((r) => (
        <div className="kv-row" key={r.k}>
          <dt>{r.k}</dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}
