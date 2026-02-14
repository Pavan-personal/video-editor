import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export default function Modal({ open, onClose, title, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog ref={ref} onCancel={onClose}
      className="fixed inset-0 z-50 m-auto w-96 rounded-lg bg-neutral-900 border border-neutral-700 text-white p-0 backdrop:bg-black/60">
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button onClick={onClose} className="p-1 hover:bg-neutral-800 rounded transition">
          <X size={16} />
        </button>
      </div>
      <div className="p-4">{children}</div>
    </dialog>
  );
}
