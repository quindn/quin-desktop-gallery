import type { SortBy } from "../lib/api";

export interface ListColumnDef {
  key: string;
  label: string;
  width: string;
  sortField?: SortBy;
  extra?: boolean; // only shown when the header row is expanded
}

export const LIST_COLUMNS: ListColumnDef[] = [
  { key: "thumb", label: "", width: "w-9" },
  { key: "name", label: "Name", width: "w-64", sortField: "name" },
  { key: "folder", label: "Folder", width: "w-40" },
  { key: "duration", label: "Dur.", width: "w-16", sortField: "duration" },
  { key: "resolution", label: "Res.", width: "w-20", sortField: "width" },
  { key: "size", label: "Size", width: "w-20", sortField: "size" },
  { key: "modified", label: "Modified", width: "w-28", sortField: "date_modified" },
  { key: "created", label: "Created", width: "w-28", sortField: "date_created", extra: true },
  { key: "taken", label: "Taken", width: "w-28", sortField: "date_taken", extra: true },
  { key: "rating", label: "Rating", width: "w-16", extra: true },
  { key: "camera", label: "Camera", width: "w-36", extra: true },
  { key: "location", label: "GPS", width: "w-14", extra: true },
];

export const LIST_HEADER_HEIGHT = 32;

function SortArrow({ desc }: { desc: boolean }) {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 transition-transform ${desc ? "" : "rotate-180"}`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function ListHeader({
  expanded,
  onToggleExpanded,
  sortBy,
  sortDesc,
  setSort,
}: {
  expanded: boolean;
  onToggleExpanded: () => void;
  sortBy: SortBy;
  sortDesc: boolean;
  setSort: (sortBy: SortBy, sortDesc: boolean) => void;
}) {
  const columns = LIST_COLUMNS.filter((c) => expanded || !c.extra);

  return (
    <div
      style={{ height: LIST_HEADER_HEIGHT }}
      className="sticky top-0 z-10 flex items-center gap-3 border-b border-hairline bg-canvas/90 px-2 backdrop-blur-sm"
    >
      <button
        onClick={onToggleExpanded}
        aria-label={expanded ? "Collapse columns" : "Expand columns"}
        title={expanded ? "Show fewer columns" : "Show all columns"}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-card-hover hover:text-text-primary"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {columns.map((col) => {
        const active = col.sortField && sortBy === col.sortField;
        return (
          <button
            key={col.key}
            disabled={!col.sortField}
            onClick={() => col.sortField && setSort(col.sortField, active ? !sortDesc : true)}
            className={`flex shrink-0 items-center gap-1 ${col.width} text-left text-[11px] font-medium uppercase tracking-wider transition-colors ${
              col.sortField ? "cursor-pointer hover:text-text-secondary" : "cursor-default"
            } ${active ? "text-text-secondary" : "text-text-tertiary"}`}
          >
            {col.label}
            {active && <SortArrow desc={sortDesc} />}
          </button>
        );
      })}
    </div>
  );
}
