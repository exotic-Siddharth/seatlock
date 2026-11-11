import { RegisterSchema } from '@seatlock/shared';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { Button, Input } from '../components/ui';
import { ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AuthLayout, DemoButton, FormError, nextQuery, safeNext } from './Login';

type Field = 'name' | 'email' | 'password';
type Errors = Partial<Record<Field | 'form', string>>;

const MESSAGES: Record<Field, (code: string) => string> = {
  name: () => 'Enter your name',
  email: () => 'Enter a valid email address',
  password: (code) => (code === 'too_big' ? 'Use at most 128 characters' : 'Use at least 10 characters'),
};

export default function Register() {
  const { user, register } = useAuth();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={safeNext(params.get('next'))} replace />;

  const set = (field: Field, value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined, form: undefined }));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = RegisterSchema.safeParse(form);
    if (!parsed.success) {
      const found: Errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as Field;
        found[field] ??= MESSAGES[field](issue.code);
      }
      setErrors(found);
      return;
    }
    setBusy(true);
    try {
      await register(parsed.data);
    } catch (error) {
      setErrors(
        error instanceof ApiError && error.code === 'EMAIL_TAKEN'
          ? { email: 'An account with this email already exists.' }
          : { form: errorMessage(error) },
      );
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Create an account"
      subtitle="It takes a few seconds. Then pick your seats."
      footer={
        <>
          Already have an account?{' '}
          <Link to={`/login${nextQuery(params.get('next'))}`} className="font-semibold text-accent hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={(e) => void onSubmit(e)} noValidate className="flex flex-col gap-4">
        <Input label="Name" autoComplete="name" value={form.name} onChange={(e) => set('name', e.target.value)} error={errors.name} />
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={(e) => set('email', e.target.value)}
          error={errors.email}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => set('password', e.target.value)}
          error={errors.password}
          hint="At least 10 characters. A short phrase works well."
        />
        {errors.form && <FormError message={errors.form} />}
        <Button type="submit" size="lg" loading={busy} className="w-full">
          Create account
        </Button>
      </form>
      <DemoButton disabled={busy} />
    </AuthLayout>
  );
}
