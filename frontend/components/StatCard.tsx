export function StatCard({ label, value, tone = "green" }: { label: string; value: string; tone?: "green" | "purple" | "orange" }) {
  return (
    <div className={`stat-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
