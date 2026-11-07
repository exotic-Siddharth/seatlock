import { useState, type ReactNode } from 'react';
import { Button, Input, Modal } from '../../components/ui';

/** A confirmation dialog that asks for one whole number (seconds, head-count) before it acts. */
export function ActionDialog({
  open,
  title,
  description,
  label,
  initial,
  min,
  max,
  confirmLabel,
  pending,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  label: string;
  initial: number;
  min: number;
  max: number;
  confirmLabel: string;
  pending: boolean;
  onConfirm: (value: number) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(String(initial));
  const value = Number(text);
  const valid = text.trim() !== '' && Number.isInteger(value) && value >= min && value <= max;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={pending} onClick={() => onConfirm(value)}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{description}</p>
      <Input
        label={label}
        type="number"
        min={min}
        max={max}
        value={text}
        onChange={(e) => setText(e.target.value)}
        error={valid ? undefined : `Enter a whole number from ${min} to ${max}`}
        className="mt-4"
      />
    </Modal>
  );
}
