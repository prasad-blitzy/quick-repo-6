/**
 * Reusable Filter/Sort Control Bar — `apps/web/src/components/FilterBar.tsx`
 *
 * A composable filter and sort control bar for the Trading Intelligence
 * dashboard. Provides market dropdown, free-text search, sort-by dropdown,
 * and sort-order toggle — all styled with the dark theme CSS custom
 * properties from `globals.css`.
 *
 * Used primarily by the TradeOpportunities page and the News Feed page.
 * Accepts a `children` slot for page-specific filter extensions (e.g.,
 * confidence slider, status filter, date range picker).
 *
 * Architecture constraints:
 * - No component library (MUI, Ant Design, Shadcn/ui) — custom HTML + CSS
 * - All styling via CSS custom properties from globals.css and utility classes
 * - TypeScript strict mode: no `any`, `exactOptionalPropertyTypes` enabled
 * - Responsive: flex-wrap layout stacks on mobile, row on desktop
 *
 * @module apps/web/src/components/FilterBar
 */

import { type ChangeEvent } from 'react';
import clsx from 'clsx';
import { Market } from '../types';

// ---------------------------------------------------------------------------
// Props Interface
// ---------------------------------------------------------------------------

/**
 * Props for the FilterBar component.
 *
 * All filter state is controlled — the parent component owns state and
 * passes it down via props with corresponding change callbacks. This
 * enables the parent to derive API query parameters directly from
 * the filter state.
 */
interface FilterBarProps {
  /** Currently selected market filter. `null` means "All Markets". */
  market: Market | null;
  /** Callback invoked when the market dropdown changes. */
  onMarketChange: (market: Market | null) => void;

  /** Active sort column identifier (e.g., `'createdAt'`, `'confidence'`). */
  sortBy: string;
  /** Callback invoked when the sort column dropdown changes. */
  onSortByChange: (sortBy: string) => void;

  /** Current sort direction — ascending or descending. */
  sortOrder: 'asc' | 'desc';
  /** Callback invoked when the sort order toggle is clicked. */
  onSortOrderChange: (order: 'asc' | 'desc') => void;

  /** Free-text search query. Empty string means no search applied. */
  search: string;
  /** Callback invoked when the search input value changes. */
  onSearchChange: (search: string) => void;

  /**
   * Optional array of sort column options rendered in the sort dropdown.
   * Defaults to `[{ value: 'createdAt', label: 'Date' }]` when omitted.
   */
  sortOptions?: Array<{ value: string; label: string }>;

  /** Optional additional CSS class names merged via clsx. */
  className?: string;

  /**
   * Optional slot for page-specific filter controls (e.g., confidence
   * slider, status dropdown, date range picker). Rendered after the
   * built-in controls.
   */
  children?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default sort options when the `sortOptions` prop is not provided. */
const DEFAULT_SORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'createdAt', label: 'Date' },
];

/**
 * Market enum values mapped to user-friendly display labels.
 * Option values use the actual Market enum string values (`us_stock`,
 * `indian_equity`, etc.) so the onChange handler can safely cast them.
 */
const MARKET_OPTIONS: ReadonlyArray<{ value: Market; label: string }> = [
  { value: Market.US_STOCK, label: 'US' },
  { value: Market.INDIAN_EQUITY, label: 'India' },
  { value: Market.CRYPTO, label: 'Crypto' },
  { value: Market.SOCIAL, label: 'Social' },
];

/**
 * Inline style overrides for form controls within the filter bar.
 *
 * The globals.css sets input/select backgrounds to `var(--color-surface)`,
 * but within the filter bar container (which itself uses `--color-surface`),
 * controls need the deeper `var(--color-background)` for visual contrast
 * and clear input field boundaries.
 */
const controlStyle: React.CSSProperties = {
  backgroundColor: 'var(--color-background)',
};

/**
 * Inline style for the sort order toggle button.
 * Styled as an icon-sized button with consistent height matching the
 * adjacent form controls, dark theme colors, and focus transition.
 */
const sortToggleStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '36px',
  height: '36px',
  backgroundColor: 'var(--color-background)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--color-text-primary)',
  fontSize: 'var(--font-size-base)',
  cursor: 'pointer',
  transition: 'border-color var(--transition-fast)',
  flexShrink: 0,
};

/**
 * Container styles for the filter bar wrapper.
 * Uses flex-wrap so controls naturally stack on narrow viewports.
 * Background uses `--color-surface` to create a distinct panel, with
 * border and border-radius matching the card pattern from globals.css.
 */
const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--spacing-3)',
  alignItems: 'center',
  padding: 'var(--spacing-3)',
  backgroundColor: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-lg)',
};

/**
 * Search input style — grows to fill remaining horizontal space, with a
 * flex basis of 200px so it wraps to full width on narrow viewports
 * (below ~320px) while sharing the row on wider screens.
 */
const searchStyle: React.CSSProperties = {
  ...controlStyle,
  flex: '1 1 200px',
  minWidth: 0,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Reusable filter and sort control bar for dashboard pages.
 *
 * Renders a flex-wrap container with:
 * 1. Free-text search input (flexible width, grows to fill space)
 * 2. Market category dropdown (All Markets / US / India / Crypto / Social)
 * 3. Sort column dropdown (customizable via `sortOptions` prop)
 * 4. Sort order toggle button (↑ ascending / ↓ descending)
 * 5. Optional children slot for page-specific extensions
 *
 * All form controls are fully controlled — state lives in the parent.
 *
 * @param props - {@link FilterBarProps}
 * @returns The rendered filter bar JSX element.
 */
export default function FilterBar(props: FilterBarProps): React.JSX.Element {
  const {
    market,
    onMarketChange,
    sortBy,
    onSortByChange,
    sortOrder,
    onSortOrderChange,
    search,
    onSearchChange,
    sortOptions = DEFAULT_SORT_OPTIONS,
    className,
    children,
  } = props;

  // -----------------------------------------------------------------------
  // Event Handlers
  // -----------------------------------------------------------------------

  /**
   * Handles market dropdown changes. Parses the selected value as a
   * Market enum member, or `null` for the "All Markets" option (empty
   * string value).
   */
  const handleMarketChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    const value = e.target.value;
    if (value === '') {
      onMarketChange(null);
      return;
    }
    // The option values are set to Market enum string values,
    // so this cast is type-safe by construction.
    onMarketChange(value as Market);
  };

  /** Handles sort column dropdown changes. */
  const handleSortByChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    onSortByChange(e.target.value);
  };

  /** Handles free-text search input changes. */
  const handleSearchChange = (e: ChangeEvent<HTMLInputElement>): void => {
    onSearchChange(e.target.value);
  };

  /** Toggles sort direction between 'asc' and 'desc'. */
  const handleSortOrderToggle = (): void => {
    onSortOrderChange(sortOrder === 'asc' ? 'desc' : 'asc');
  };

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div
      className={clsx('filter-bar', className)}
      role="search"
      style={containerStyle}
    >
      {/* Search input — takes remaining horizontal space via flex-grow */}
      <input
        type="text"
        placeholder="Search..."
        value={search}
        onChange={handleSearchChange}
        aria-label="Search articles and opportunities"
        style={searchStyle}
      />

      {/* Market category filter dropdown */}
      <select
        value={market ?? ''}
        onChange={handleMarketChange}
        aria-label="Filter by market"
        style={controlStyle}
      >
        <option value="">All Markets</option>
        {MARKET_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Sort column dropdown */}
      <select
        value={sortBy}
        onChange={handleSortByChange}
        aria-label="Sort by"
        style={controlStyle}
      >
        {sortOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Sort order toggle button (ascending ↑ / descending ↓) */}
      <button
        type="button"
        onClick={handleSortOrderToggle}
        aria-label={
          sortOrder === 'asc' ? 'Sort ascending' : 'Sort descending'
        }
        title={sortOrder === 'asc' ? 'Sort ascending' : 'Sort descending'}
        style={sortToggleStyle}
      >
        {sortOrder === 'asc' ? '↑' : '↓'}
      </button>

      {/* Children slot — page-specific filter extensions */}
      {children}
    </div>
  );
}
