import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { useActionLock } from "./useActionLock";

export const MAX_BULK_DELETE = 100;
export interface BulkDeleteItem { id: string; label: string }
interface Confirmation {
  items: BulkDeleteItem[];
  filteredCount: number;
  scopeKey: string;
}
export interface BulkDeleteResult {
  succeeded: BulkDeleteItem[];
  failed: Array<BulkDeleteItem & { error: unknown }>;
  scopeKey: string;
}
interface Options<T extends { id: string }> {
  items: readonly T[];
  filtered: readonly T[];
  selected: ReadonlySet<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  label: (item: T) => string;
  eligible: (item: T) => boolean;
  canDelete: boolean;
  canSelect?: boolean;
  remove: (item: T) => Promise<void>;
  onDeleted: (ids: ReadonlySet<string>) => void;
  afterDelete?: () => Promise<void>;
  pending: string | null;
  run: ReturnType<typeof useActionLock>["run"];
  busy?: boolean;
  scopeKey: string;
  filterKey: string;
}

export function useBulkDelete<T extends { id: string }>(options: Options<T>) {
  const latest = useRef(options);
  latest.current = options;
  const inFlight = useRef(false);
  const confirmationRef = useRef<Confirmation | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [result, setResult] = useState<BulkDeleteResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [progress, setProgress] = useState(0);
  const selectable = options.filtered.filter(options.eligible);
  const selectedItems = selectable.filter(item => options.selected.has(item.id));
  const isBusy = () => inFlight.current || !!latest.current.pending || !!latest.current.busy || !!confirmationRef.current;

  useEffect(() => {
    options.setSelected(new Set());
    if (!inFlight.current) {
      confirmationRef.current = null;
      setConfirmation(null);
    }
  }, [options.scopeKey, options.filterKey]);
  useEffect(() => { setResult(null); setError(null); }, [options.scopeKey]);

  const changeSelection = (ids: readonly string[], checked: boolean, replace = false) => {
    const live = latest.current;
    if (isBusy() || !(live.canSelect ?? live.canDelete)) {
      setError("errors.bulkDelete.unavailable");
      return;
    }
    const eligibleIds = new Set(live.filtered.filter(live.eligible).map(item => item.id));
    live.setSelected(previous => {
      const next = replace ? new Set<string>() : new Set([...previous].filter(id => eligibleIds.has(id)));
      ids.forEach(id => {
        if (checked && eligibleIds.has(id)) next.add(id);
        else next.delete(id);
      });
      return next;
    });
    setError(null);
  };

  const openConfirmation = () => {
    const live = latest.current;
    if (isBusy() || !live.canDelete) { setError("errors.bulkDelete.unavailable"); return; }
    const items = live.filtered.filter(item => live.eligible(item) && live.selected.has(item.id))
      .map(item => ({ id: item.id, label: live.label(item) }));
    if (items.length === 0 || items.length > MAX_BULK_DELETE) {
      setError(items.length ? "errors.bulkDelete.tooMany" : "errors.bulkDelete.empty");
      return;
    }
    const snapshot = { items, filteredCount: live.filtered.length, scopeKey: live.scopeKey };
    confirmationRef.current = snapshot;
    setConfirmation(snapshot);
    setError(null);
  };
  const closeConfirmation = () => {
    if (inFlight.current || latest.current.pending) return;
    confirmationRef.current = null;
    setConfirmation(null);
  };

  const execute = async () => {
    const snapshot = confirmationRef.current;
    if (inFlight.current || latest.current.pending) return;
    if (!snapshot || !latest.current.canDelete || snapshot.scopeKey !== latest.current.scopeKey) {
      setError("errors.bulkDelete.unavailable");
      return;
    }
    inFlight.current = true;
    setProgress(0);
    setError(null);
    try {
      await latest.current.run("bulk-delete", async () => {
        const outcome: BulkDeleteResult = { succeeded: [], failed: [], scopeKey: snapshot.scopeKey };
        // Only the confirmed IDs are used; grants, permissions and ownership
        // are rechecked from the current cache before each sequential DELETE.
        for (const item of snapshot.items) {
          try {
            const live = latest.current;
            const row = live.items.find(row => row.id === item.id);
            if (live.scopeKey !== snapshot.scopeKey || !live.canDelete || !row || !live.eligible(row)) {
              throw new Error("errors.bulkDelete.unavailable");
            }
            await live.remove(row);
            outcome.succeeded.push(item);
          } catch (failure) {
            outcome.failed.push({ ...item, error: failure });
          }
          setProgress(outcome.succeeded.length + outcome.failed.length);
        }
        confirmationRef.current = null;
        setConfirmation(null);
        if (latest.current.scopeKey !== snapshot.scopeKey) return;
        latest.current.onDeleted(new Set(outcome.succeeded.map(item => item.id)));
        latest.current.setSelected(new Set(outcome.failed.map(item => item.id)));
        setResult(outcome);
        if (outcome.succeeded.length) await latest.current.afterDelete?.();
      });
    } catch (failure) {
      setError(failure);
    } finally {
      inFlight.current = false;
    }
  };

  return {
    selected: new Set(selectedItems.map(item => item.id)),
    selectedCount: selectedItems.length,
    selectableCount: selectable.length,
    excludedCount: options.filtered.length - selectable.length,
    filteredCount: options.filtered.length,
    maxBatch: MAX_BULK_DELETE,
    canDelete: options.canDelete,
    canSelect: options.canSelect ?? options.canDelete,
    busy: !!options.pending || !!options.busy || !!confirmation,
    running: options.pending === "bulk-delete",
    confirmation: confirmation?.scopeKey === options.scopeKey ? confirmation : null,
    result: result?.scopeKey === options.scopeKey ? result : null,
    error, progress, isBusy, execute, openConfirmation, closeConfirmation, changeSelection,
    isDeleting: () => inFlight.current || !!confirmationRef.current,
    selectAll: () => changeSelection(latest.current.filtered.map(item => item.id), true, true),
    clearSelection: () => changeSelection([], false, true),
    toggle: (id: string) => changeSelection([id], !latest.current.selected.has(id)),
  };
}

export type BulkDeleteController = ReturnType<typeof useBulkDelete>;
