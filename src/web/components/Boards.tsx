import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { api, type Board } from '../api';
import { setActiveBoard, toast, useApp } from '../store';
import { Dialog } from './common';

/** The boards, refreshed on every library change. */
export function useBoards(): { boards: Board[]; none: number; loaded: boolean; reload: () => void } {
  const rev = useApp((s) => s.libraryRev);
  const [data, setData] = useState<{ boards: Board[]; none: number; loaded: boolean }>({ boards: [], none: 0, loaded: false });
  const reload = () =>
    void api
      .boards()
      .then((r) => setData({ ...r, loaded: true }))
      .catch(() => undefined);
  useEffect(reload, [rev]);
  return { ...data, reload };
}

/** Ask for a board name (new board or rename). Resolves through onDone; validation errors come from the server. */
export function BoardNameDialog({ title, initial = '', onDone, onClose }: { title: string; initial?: string; onDone: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onDone(name.trim());
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <label className="field">
        <span>Board name</span>
        <input
          className="input"
          aria-label="Board name"
          value={name}
          maxLength={60}
          placeholder="e.g. Client X, Logos, Summer shoot"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
      </label>
      <div className="field-row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!name.trim() || busy} onClick={() => void submit()}>
          Save
        </button>
      </div>
    </Dialog>
  );
}

const NEW = '__new__';

/**
 * Top bar: the board new results go to (Invoke's "auto-add board"). New versions of a picture stay in that picture's
 * board; everything new — generations, uploads, videos — lands here.
 */
export function WorkingBoardPicker() {
  const board = useApp((s) => s.board);
  const { boards, loaded } = useBoards();
  const [creating, setCreating] = useState(false);
  // a board deleted elsewhere: fall back to "No board"
  useEffect(() => {
    if (board && loaded && !boards.some((b) => b.id === board)) setActiveBoard(null);
  }, [board, boards, loaded]);
  return (
    <>
      <label className="board-picker" title="New pictures and videos are saved to this board. New versions of a picture stay in that picture's board.">
        <FolderOpen size={14} aria-hidden />
        <span className="sr">Working board</span>
        <select
          aria-label="Working board"
          value={board ?? ''}
          onChange={(e) => (e.target.value === NEW ? setCreating(true) : setActiveBoard(e.target.value || null))}
        >
          <option value="">No board</option>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
          <option value={NEW}>＋ New board…</option>
        </select>
      </label>
      {creating && (
        <BoardNameDialog
          title="New board"
          onClose={() => setCreating(false)}
          onDone={async (name) => {
            const b = await api.createBoard(name);
            setActiveBoard(b.id);
            toast(`New pictures now go to "${b.name}".`, 'ok');
          }}
        />
      )}
    </>
  );
}
