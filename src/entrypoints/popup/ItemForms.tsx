// SPDX-License-Identifier: GPL-3.0-only
// The parts of the item page that differ by type (mockups item-types 2B, 3A, 4, 6): the card picture, the card and
// identity forms and views, and custom fields. ItemView keeps the page around them (header, save, delete, sheets).
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Copy, Eye, EyeOff, Plus, X } from 'lucide-preact';
import { brandKey, brandOf, digits, expired, formatNumber, luhn, parseExpiry, showExpiry, typeExpiry } from '../../core/cards';
import type { FieldDraft } from '../../core/edit';
import type { FullItem } from '../../core/vault';

type Vals = Record<string, string | null>;
export type CopyFn = (value: string | null | undefined, what: string, sensitive: boolean) => void;

export function Kv({ label, children, actions }: { label: ComponentChildren; children: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <div class="kv">
      <div class="k">
        <small>{label}</small>
        {children}
      </div>
      {actions}
    </div>
  );
}

export function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label class="sw">
      <input type="checkbox" role="switch" aria-label={label} checked={on} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
      <i />
    </label>
  );
}

const dots = (s: string, max = 16) => '•'.repeat(Math.min(max, s.length));
const val = (e: Event) => (e.currentTarget as HTMLInputElement).value;

export function EyeBtn({ on, what, onClick }: { on: boolean; what: string; onClick: () => void }) {
  return (
    <button type="button" class="ib" aria-label={`${on ? 'Hide' : 'Show'} ${what}`} title={`${on ? 'Hide' : 'Show'} ${what}`} onClick={onClick}>
      {on ? <EyeOff /> : <Eye />}
    </button>
  );
}

export function CopyBtn({ what, onClick }: { what: string; onClick: () => void }) {
  return (
    <button type="button" class="ib" aria-label={`Copy ${what.toLowerCase()}`} title={`Copy ${what.toLowerCase()}`} onClick={onClick}>
      <Copy />
    </button>
  );
}

// ---------- cards ----------

/** The card picture on top of a card's form and page. The number shows as its last four digits only. */
export function CardFace({ card }: { card: Vals }) {
  const d = digits(card.number);
  const k = brandKey(card.brand || brandOf(d));
  const label: Partial<Record<string, string>> = { visa: 'VISA', mastercard: 'mastercard', amex: 'AMEX', discover: 'DISCOVER', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay', maestro: 'maestro' };
  const empty = !d && !card.cardholderName;
  const exp = showExpiry(card.expMonth, card.expYear);
  return (
    <div class={`cardface cf-${empty ? 'empty' : k}`} aria-hidden="true">
      <span class="cf-brand">{label[k] ?? card.brand ?? ''}</span>
      <i class="cf-chip" />
      <div class="cf-num">{d ? `•••• •••• •••• ${d.slice(-4)}` : '•••• •••• •••• ••••'}</div>
      <div class="cf-bot">
        <span>
          <small>Cardholder</small>
          {card.cardholderName || 'Your name'}
        </span>
        <span>
          <small>Expires</small>
          {exp || 'MM/YY'}
        </span>
      </div>
    </div>
  );
}

export function CardView({ card, copy }: { card: Vals; copy: CopyFn }) {
  const [show, setShow] = useState<Record<string, boolean>>({});
  const flip = (k: string) => setShow((s) => ({ ...s, [k]: !s[k] }));
  const exp = showExpiry(card.expMonth, card.expYear);
  const old = expired(card.expMonth, card.expYear);
  return (
    <>
      <CardFace card={card} />
      <div class="group">
        {card.number && (
          <Kv label="Number" actions={<><EyeBtn on={!!show.number} what="number" onClick={() => flip('number')} /><CopyBtn what="Number" onClick={() => copy(digits(card.number), 'Number', true)} /></>}>
            <div class="mono">{show.number ? formatNumber(card.number) : `•••• •••• •••• ${digits(card.number).slice(-4)}`}</div>
          </Kv>
        )}
        {exp && (
          <Kv label={old ? <>Expires<span class="pill bad">Expired</span></> : 'Expires'} actions={<CopyBtn what="Expiry" onClick={() => copy(exp, 'Expiry', false)} />}>
            <div class="mono">{exp}</div>
          </Kv>
        )}
        {card.code && (
          <Kv label="Security code" actions={<><EyeBtn on={!!show.code} what="security code" onClick={() => flip('code')} /><CopyBtn what="Security code" onClick={() => copy(card.code, 'Security code', true)} /></>}>
            <div class="mono">{show.code ? card.code : dots(card.code, 4)}</div>
          </Kv>
        )}
        {card.cardholderName && (
          <Kv label="Cardholder" actions={<CopyBtn what="Cardholder" onClick={() => copy(card.cardholderName, 'Cardholder', false)} />}>
            <div>{card.cardholderName}</div>
          </Kv>
        )}
        {card.brand && !card.number && (
          <Kv label="Brand">
            <div>{card.brand}</div>
          </Kv>
        )}
      </div>
    </>
  );
}

/** Card form (2B): picture, number, cardholder, expiry and code, then the optional name. */
export function CardForm({ card, name, onCard, onName, nameErr }: { card: Vals; name: string; onCard: (p: Vals) => void; onName: (v: string) => void; nameErr: string | null }) {
  const [showNum, setShowNum] = useState(!card.number);
  const [showCode, setShowCode] = useState(!card.code);
  const [exp, setExp] = useState(() => (card.expMonth || card.expYear ? showExpiry(card.expMonth, card.expYear).replace('/', ' / ').replace(/·/g, '') : ''));
  const d = digits(card.number);
  const badNum = d.length >= 12 && !luhn(d);
  const old = expired(card.expMonth, card.expYear);
  return (
    <>
      <CardFace card={card} />
      <label class={`field${badNum ? ' err' : ''}`}>
        <span class="l">Number</span>
        <span class="inp">
          <input
            id="f-number"
            class={`mono${showNum ? '' : ' masked'}`}
            inputMode="numeric"
            autocomplete="off"
            spellcheck={false}
            placeholder="1234 5678 9012 3456"
            value={formatNumber(card.number ?? '')}
            onInput={(e) => {
              const n = digits(val(e)).slice(0, 19);
              (e.currentTarget as HTMLInputElement).value = formatNumber(n);
              onCard({ number: n || null, brand: brandOf(n) ?? (n ? (card.brand ?? null) : null) });
            }}
          />
          <EyeBtn on={showNum} what="number" onClick={() => setShowNum(!showNum)} />
        </span>
        {badNum && <span class="f-msg">This number doesn't look right. Check it against the card.</span>}
      </label>
      <label class="field">
        <span class="l">Cardholder name</span>
        <span class="inp">
          <input id="f-holder" autocomplete="off" placeholder="As printed on the card" value={card.cardholderName ?? ''} onInput={(e) => onCard({ cardholderName: val(e) || null })} />
        </span>
      </label>
      <div class="two">
        <label class={`field${old ? ' err' : ''}`}>
          <span class="l">Expires</span>
          <span class="inp">
            <input
              id="f-exp"
              class="mono"
              inputMode="numeric"
              autocomplete="off"
              placeholder="MM / YY"
              value={exp}
              onInput={(e) => {
                const t = typeExpiry(val(e), exp);
                setExp(t);
                (e.currentTarget as HTMLInputElement).value = t;
                const p = parseExpiry(t);
                onCard({ expMonth: p.month, expYear: p.year });
              }}
            />
          </span>
          {old && <span class="f-msg">Expired</span>}
        </label>
        <label class="field">
          <span class="l">Security code</span>
          <span class="inp">
            <input id="f-code" class={`mono${showCode ? '' : ' masked'}`} inputMode="numeric" autocomplete="off" placeholder="CVC" maxLength={4} value={card.code ?? ''} onInput={(e) => onCard({ code: digits(val(e)).slice(0, 4) || null })} />
            <EyeBtn on={showCode} what="security code" onClick={() => setShowCode(!showCode)} />
          </span>
        </label>
      </div>
      <label class={`field${nameErr ? ' err' : ''}`}>
        <span class="l">
          Name<small>Optional</small>
        </span>
        <span class="inp">
          <input id="f-name" value={name} maxLength={1000} placeholder={[card.brand || (d ? 'Card' : ''), d ? `•${d.slice(-4)}` : ''].filter(Boolean).join(' ') || 'Visa •4242'} onInput={(e) => onName(val(e))} />
        </span>
        {nameErr && <span class="f-msg">{nameErr}</span>}
      </label>
    </>
  );
}

// ---------- identities ----------

const EXTRA: Array<[string, string, boolean?]> = [
  ['address2', 'Address line 2'],
  ['address3', 'Address line 3'],
  ['country', 'Country'],
  ['company', 'Company'],
  ['middleName', 'Middle name'],
  ['title', 'Title'],
  ['username', 'Username'],
  ['ssn', 'SSN', true],
  ['passportNumber', 'Passport number', true],
  ['licenseNumber', "Driver's license", true],
];
const SECRET_ID = new Set(['ssn', 'passportNumber', 'licenseNumber']);

/** The address as one block, the way it's pasted: lines, then "City, ST 12345", then the country. */
export function addressOf(i: Vals): string {
  const line = [[i.city, i.state].filter(Boolean).join(', '), i.postalCode].filter(Boolean).join(' ');
  return [i.address1, i.address2, i.address3, line, i.country].filter((x) => x?.trim()).join('\n');
}

export function IdentityView({ identity: i, copy }: { identity: Vals; copy: CopyFn }) {
  const [show, setShow] = useState<Record<string, boolean>>({});
  const name = [i.title, i.firstName, i.middleName, i.lastName].filter(Boolean).join(' ');
  const addr = addressOf(i);
  const row = (label: string, v: string | null | undefined): ComponentChildren =>
    v ? (
      <Kv label={label} actions={<CopyBtn what={label} onClick={() => copy(v, label, false)} />}>
        <div>{v}</div>
      </Kv>
    ) : null;
  const ids = ([['ssn', 'SSN'], ['passportNumber', 'Passport'], ['licenseNumber', "Driver's license"]] as const).filter(([k]) => i[k]);
  return (
    <>
      {(name || i.email || i.phone || addr || i.company || i.username) && (
        <div class="group">
          {row('Name', name)}
          {row('Email', i.email)}
          {row('Phone', i.phone)}
          {addr && (
            <Kv label="Address" actions={<CopyBtn what="Address" onClick={() => copy(addr, 'Address', false)} />}>
              <div class="addr">{addr}</div>
            </Kv>
          )}
          {row('Company', i.company)}
          {row('Username', i.username)}
        </div>
      )}
      {ids.length > 0 && (
        <>
          <div class="g-title">ID numbers</div>
          <div class="group">
            {ids.map(([k, label]) => (
              <Kv label={label} actions={<><EyeBtn on={!!show[k]} what={label} onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))} /><CopyBtn what={label} onClick={() => copy(i[k], label, true)} /></>}>
                <div class="mono">{show[k] ? i[k] : dots(i[k]!, 12)}</div>
              </Kv>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** Identity form (3A): the usual fields, and a chip for each of the rest. A field with a value always shows. */
export function IdentityForm({ identity: i, name, onId, onName, nameErr }: { identity: Vals; name: string; onId: (p: Vals) => void; onName: (v: string) => void; nameErr: string | null }) {
  const [added, setAdded] = useState<string[]>([]);
  const [show, setShow] = useState<Record<string, boolean>>({});
  const open = EXTRA.filter(([k]) => i[k] != null || added.includes(k));
  const closed = EXTRA.filter(([k]) => !(i[k] != null || added.includes(k)));
  const text = (k: string, label: string | null, ph = '', extra: Record<string, unknown> = {}) => (
    <label class="field">
      {label && <span class="l">{label}</span>}
      <span class="inp">
        <input id={`f-${k}`} aria-label={label ?? ph} placeholder={ph} autocomplete="off" value={i[k] ?? ''} onInput={(e) => onId({ [k]: val(e) || null })} {...extra} />
      </span>
    </label>
  );
  return (
    <>
      <label class={`field${nameErr ? ' err' : ''}`}>
        <span class="l">
          Name<small>Optional</small>
        </span>
        <span class="inp">
          <input id="f-name" value={name} maxLength={1000} placeholder={[i.firstName, i.lastName].filter(Boolean).join(' ') || 'Alex Rivera'} onInput={(e) => onName(val(e))} />
        </span>
        {nameErr && <span class="f-msg">{nameErr}</span>}
      </label>
      <div class="two">
        {text('firstName', 'First name')}
        {text('lastName', 'Last name')}
      </div>
      {text('email', 'Email', '', { type: 'email', spellcheck: false })}
      {text('phone', 'Phone', '', { type: 'tel' })}
      {text('address1', 'Address', 'Street address')}
      <div class="three">
        {text('city', null, 'City')}
        {text('state', null, 'State')}
        {text('postalCode', null, 'ZIP')}
      </div>
      {open.map(([k, label, secret]) => (
        <label class="field">
          <span class="l">
            {label}
            {secret && <small>Hidden when you view it</small>}
          </span>
          <span class="inp">
            <input id={`f-${k}`} class={secret ? `mono${show[k] ? '' : ' masked'}` : ''} autocomplete="off" spellcheck={false} value={i[k] ?? ''} onInput={(e) => onId({ [k]: val(e) })} />
            {secret && <EyeBtn on={!!show[k]} what={label.toLowerCase()} onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))} />}
            <button
              type="button"
              class="ib"
              aria-label={`Remove ${label.toLowerCase()}`}
              title="Remove"
              onClick={() => {
                setAdded((a) => a.filter((x) => x !== k));
                onId({ [k]: null });
              }}
            >
              <X />
            </button>
          </span>
        </label>
      ))}
      {closed.length > 0 && (
        <div class="add-chips">
          {closed.map(([k, label]) => (
            <button
              type="button"
              class="add-chip"
              onClick={() => {
                setAdded((a) => [...a, k]);
                setTimeout(() => document.getElementById(`f-${k}`)?.focus(), 0);
              }}
            >
              <Plus />
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ---------- custom fields ----------

const LINKED: Record<number, string> = { 100: 'Username', 101: 'Password', 300: 'Cardholder name', 301: 'Expiry month', 302: 'Expiry year', 303: 'Security code', 304: 'Brand', 305: 'Number' };
const linkedLabel = (id: number | null | undefined) => (id != null && id >= 400 ? 'an identity field' : (LINKED[id ?? -1] ?? 'another field'));

export function FieldsView({ fields, copy }: { fields: NonNullable<FullItem['fields']>; copy: CopyFn }) {
  const [show, setShow] = useState<Record<number, boolean>>({});
  return (
    <>
      <div class="g-title">Custom fields</div>
      <div class="group">
        {fields.map((f, k) => {
          const label = f.name || 'Field';
          if (f.type === 3)
            return (
              <Kv label={label}>
                <div class="muted">Linked to the {linkedLabel(f.linkedId).toLowerCase()}</div>
              </Kv>
            );
          if (f.type === 2)
            return (
              <Kv label={label}>
                <div>{f.value === 'true' ? 'Yes' : 'No'}</div>
              </Kv>
            );
          const hidden = f.type === 1;
          return (
            <Kv label={label} actions={<>{hidden && f.value && <EyeBtn on={!!show[k]} what={label} onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))} />}{f.value && <CopyBtn what={label} onClick={() => copy(f.value, label, hidden)} />}</>}>
              <div class={hidden ? 'mono' : ''}>{hidden && !show[k] ? dots(f.value ?? '', 10) : f.value || <span class="muted">Empty</span>}</div>
            </Kv>
          );
        })}
      </div>
    </>
  );
}

export function FieldsForm({ fields, onChange }: { fields: FieldDraft[]; onChange: (f: FieldDraft[]) => void }) {
  const [show, setShow] = useState<Record<number, boolean>>({});
  const set = (k: number, p: Partial<FieldDraft>) => onChange(fields.map((f, i) => (i === k ? { ...f, ...p } : f)));
  const add = (type: number) => {
    onChange([...fields, { name: '', value: type === 2 ? 'false' : '', type }]);
    setTimeout(() => document.getElementById(`f-cf${fields.length}`)?.focus(), 0);
  };
  return (
    <div class="field">
      <span class="l">Custom fields</span>
      {fields.length > 0 && (
        <div class="group">
          {fields.map((f, k) => (
            <div class="cf">
              <span class="inp">
                <input id={`f-cf${k}`} aria-label={`Field ${k + 1} name`} placeholder="Name" value={f.name} onInput={(e) => set(k, { name: val(e) })} />
              </span>
              {f.type === 3 ? (
                <span class="cf-fixed muted">Linked to the {linkedLabel(f.linkedId).toLowerCase()}</span>
              ) : f.type === 2 ? (
                <span class="cf-fixed">
                  <Switch on={f.value === 'true'} label={`${f.name || 'Field'} on`} onChange={(v) => set(k, { value: v ? 'true' : 'false' })} />
                </span>
              ) : (
                <span class="inp">
                  <input aria-label={`Field ${k + 1} value`} placeholder="Value" class={f.type === 1 ? `mono${show[k] ? '' : ' masked'}` : ''} autocomplete="off" spellcheck={false} value={f.value} onInput={(e) => set(k, { value: val(e) })} />
                  {f.type === 1 && <EyeBtn on={!!show[k]} what="value" onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))} />}
                </span>
              )}
              <button type="button" class="ib" aria-label={`Remove field ${k + 1}`} title="Remove" onClick={() => onChange(fields.filter((_, i) => i !== k))}>
                <X />
              </button>
            </div>
          ))}
        </div>
      )}
      <div class="cf-adds">
        <button type="button" class="btn ghost add" onClick={() => add(0)}>
          <Plus />
          Add text field
        </button>
        <button type="button" class="btn ghost add" onClick={() => add(1)}>
          <Plus />
          Add hidden field
        </button>
        <button type="button" class="btn ghost add" onClick={() => add(2)}>
          <Plus />
          Add checkbox
        </button>
      </div>
    </div>
  );
}
