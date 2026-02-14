import { useEffect } from 'react';
import { AlertCircle, CheckCircle, X } from 'lucide-react';

interface Props {
  message: string;
  type?: 'error' | 'success';
  onClose: () => void;
}

export default function Toast({ message, type = 'error', onClose }: Props) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);

  if (!message) return null;

  const colors = type === 'error'
    ? 'bg-red-950 border-red-800 text-red-200'
    : 'bg-green-950 border-green-800 text-green-200';

  return (
    <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg border shadow-lg ${colors} animate-[slideIn_0.2s_ease]`}>
      {type === 'error' ? <AlertCircle size={16} /> : <CheckCircle size={16} />}
      <span className="text-sm">{message}</span>
      <button onClick={onClose} className="ml-2 p-0.5 hover:opacity-70 transition">
        <X size={14} />
      </button>
    </div>
  );
}
