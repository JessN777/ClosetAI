export default function ClosetLoadingSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`closet-loading-skeleton ${compact ? "is-compact" : ""}`} role="status" aria-label="Loading your saved closet">
      {Array.from({ length: compact ? 2 : 3 }, (_, index) => (
        <div className="closet-skeleton-card" key={index}>
          <span className="closet-skeleton-image" />
          <span className="closet-skeleton-line" />
          <span className="closet-skeleton-line is-short" />
        </div>
      ))}
      <span className="visually-hidden">Loading saved garments…</span>
    </div>
  );
}
