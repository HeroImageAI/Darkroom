import { useEffect } from 'react';
import { api } from '../api';
import { compositionToEdit } from '../lib/canvasStart';
import { go } from '../router';
import { toast, useApp } from '../store';
import type { Composition } from '../../shared/compose';

/**
 * Compose is part of Edit (DECISIONS 125, 126): an old link to Compose opens Edit, and an old link to one composition
 * opens it in Edit as layers (a copy).
 */
export function Compose({ id }: { id?: string }) {
  const online = useApp((s) => s.status?.comfy === 'online');
  useEffect(() => {
    if (!id) return go('edit');
    if (!online) return;
    api
      .get<Composition>(`/api/compositions/${id}`)
      .then(compositionToEdit)
      .then((itemId) => go('edit', itemId))
      .catch((e) => {
        toast((e as Error).message, 'error');
        go('edit');
      });
  }, [id, online]);
  return (
    <div className="empty" style={{ margin: 'auto' }}>
      {id ? (online ? 'Opening the composition in Edit…' : 'Start ComfyUI (top right) to open this composition in Edit.') : 'Opening Edit…'}
    </div>
  );
}
