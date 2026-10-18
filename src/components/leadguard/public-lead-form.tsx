import {useRef, useState, type FormEvent} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Brand} from './shared';
import {submitPublicLead} from '@/services/lead-intake.functions';

/** Public, unauthenticated lead form. The workspace comes from the URL slug and is resolved by the server. */
export function PublicLeadForm({slug}: {slug: string}) {
  const startedAt = useRef(Date.now());
  const clientKey = useRef(crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const form = new FormData(e.currentTarget);
    setPending(true); setError(null); setFieldErrors({});
    try {
      const result = await submitPublicLead({data: {
        slug, name: String(form.get('name') ?? ''), email: String(form.get('email') ?? ''), phone: String(form.get('phone') ?? ''),
        message: String(form.get('message') ?? ''), website: String(form.get('website') ?? ''),
        startedAt: startedAt.current, clientKey: clientKey.current,
      }});
      if (result.ok) setDone(result.message);
      else { setError(result.message); setFieldErrors(result.fieldErrors ?? {}); }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 px-4 py-10">
      <Brand />
      {done ? (
        <section className="panel p-6" role="status"><h1 className="text-xl font-semibold">Thank you</h1><p className="mt-2 text-sm text-muted-foreground">{done}</p></section>
      ) : (
        <form className="panel space-y-4 p-6" onSubmit={onSubmit} noValidate>
          <div><h1 className="text-xl font-semibold">Get in touch</h1><p className="mt-1 text-sm text-muted-foreground">Tell us how we can help and we will reply shortly.</p></div>
          <label className="field-label">Your name<Input name="name" required maxLength={200} autoComplete="name" aria-invalid={Boolean(fieldErrors['name'])}/>{fieldErrors['name'] && <span className="text-xs text-destructive">{fieldErrors['name']}</span>}</label>
          <label className="field-label">Email<Input name="email" type="email" maxLength={320} autoComplete="email" aria-invalid={Boolean(fieldErrors['email'])}/>{fieldErrors['email'] && <span className="text-xs text-destructive">{fieldErrors['email']}</span>}</label>
          <label className="field-label">Phone<Input name="phone" type="tel" maxLength={40} autoComplete="tel" aria-invalid={Boolean(fieldErrors['phone'])}/>{fieldErrors['phone'] && <span className="text-xs text-destructive">{fieldErrors['phone']}</span>}</label>
          <label className="field-label">How can we help?<textarea name="message" maxLength={2000} rows={4}/></label>
          {/* Honeypot: hidden from people and assistive tech; bots tend to fill it. */}
          <div aria-hidden="true" style={{position: 'absolute', left: '-10000px', height: 0, overflow: 'hidden'}}>
            <label>Website<input name="website" tabIndex={-1} autoComplete="off"/></label>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={pending} className="w-full">{pending ? 'Sending…' : 'Send'}</Button>
        </form>
      )}
    </main>
  );
}
