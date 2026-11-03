// SPDX-License-Identifier: GPL-3.0-only
// The parts of the item page that differ by type (mockups item-types 2B, 3A, 4, 6): the card picture, the card and
// identity forms and views, and custom fields. ItemView keeps the page around them (header, save, delete, sheets).
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Copy, Eye, EyeOff, Plus, X } from 'lucide-preact';
import { brandKey, brandOf, digits, expired, formatNumber, luhn, parseExpiry, showExpiry, typeExpiry } from '../../core/cards';
import type { FieldDraft } from '../../core/edit';
import { ageOf, dateProblem, docLine, extrasOf, GENDERS, isoDate, longDate, maskDate, readDate, usDate, withExtra, type Extra } from '../../core/identity';
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

/** Fields the form opens with a chip: identity slots, the custom-field details (x:), and the two documents (doc:). */
const EXTRA: Array<[string, string, boolean?]> = [
  ['address2', 'Address line 2'],
  ['address3', 'Address line 3'],
  ['country', 'Country'],
  ['company', 'Company'],
  ['x:jobTitle', 'Job title'],
  ['middleName', 'Middle name'],
  ['title', 'Title'],
  ['x:suffix', 'Suffix'],
  ['username', 'Username'],
  ['x:nationality', 'Nationality'],
  ['ssn', 'SSN', true],
  ['doc:passport', 'Passport'],
  ['doc:license', "Driver's license"],
];

/** The address as one block, the way it's pasted: lines, then "City, ST 12345", then the country. */
export function addressOf(i: Vals): string {
  const line = [[i.city, i.state].filter(Boolean).join(', '), i.postalCode].filter(Boolean).join(' ');
  return [i.address1, i.address2, i.address3, line, i.country].filter((x) => x?.trim()).join('\n');
}

/** A saved date as the popup shows it: MM/DD/YYYY, or as typed when it isn't a date we read. */
const shownDate = (v: string | undefined) => {
  const p = readDate(v);
  return p ? usDate(p) : (v ?? '');
};

export function IdentityView({ identity: i, fields, copy }: { identity: Vals; fields: FullItem['fields']; copy: CopyFn }) {
  const [show, setShow] = useState<Record<string, boolean>>({});
  const x = extrasOf(fields).values;
  const name = [i.title, i.firstName, i.middleName, i.lastName, x.suffix].filter(Boolean).join(' ');
  const addr = addressOf(i);
  const dob = readDate(x.dob);
  const work = [x.jobTitle, i.company].filter(Boolean).join(', ');
  const row = (label: string, v: string | null | undefined, shown?: ComponentChildren): ComponentChildren =>
    v ? (
      <Kv label={label} actions={<CopyBtn what={label} onClick={() => copy(v, label, false)} />}>
        <div>{shown ?? v}</div>
      </Kv>
    ) : null;
  const docs = [
    { k: 'ssn', label: 'SSN', sub: null },
    { k: 'passportNumber', label: 'Passport', sub: docLine(x.passportCountry, x.passportExpiry, 6) },
    { k: 'licenseNumber', label: "Driver's license", sub: docLine(x.licenseState, x.licenseExpiry, 1) },
  ].filter((d) => i[d.k] || d.sub);
  return (
    <>
      {(name || x.dob || x.gender || i.email || i.phone || addr || work || i.username) && (
        <div class="group">
          {row('Name', name)}
          {row('Date of birth', x.dob && shownDate(x.dob), dob ? (
            <>
              {longDate(dob)} <span class="age">· {ageOf(dob)}</span>
            </>
          ) : undefined)}
          {row('Gender', x.gender)}
          {row('Email', i.email)}
          {row('Phone', i.phone)}
          {addr && (
            <Kv label="Address" actions={<CopyBtn what="Address" onClick={() => copy(addr, 'Address', false)} />}>
              <div class="addr">{addr}</div>
            </Kv>
          )}
          {row(x.jobTitle && i.company ? 'Work' : x.jobTitle ? 'Job title' : 'Company', work)}
          {row('Username', i.username)}
        </div>
      )}
      {(docs.length > 0 || x.nationality) && (
        <>
          <div class="g-title">ID numbers</div>
          <div class="group">
            {docs.map(({ k, label, sub }) => (
              <Kv
                label={label}
                actions={
                  i[k] ? (
                    <>
                      <EyeBtn on={!!show[k]} what={label} onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))} />
                      <CopyBtn what={label} onClick={() => copy(i[k], label, true)} />
                    </>
                  ) : undefined
                }
              >
                {i[k] && <div class="mono">{show[k] ? i[k] : dots(i[k]!, 12)}</div>}
                {sub && <div class={`sub${sub.tone ? ` ${sub.tone}` : ''}`}>{sub.text}</div>}
              </Kv>
            ))}
            {row('Nationality', x.nationality)}
          </div>
        </>
      )}
    </>
  );
}

/** A date box: digits get their slashes, and a date that can't exist says so once it's typed in full. */
function DateBox({ id, label, value, past, onDate }: { id: string; label: string; value: string | undefined; past: boolean; onDate: (v: string | null) => void }) {
  const [text, setText] = useState(() => shownDate(value));
  const [left, setLeft] = useState(false);
  const bad = (left || text.length >= 10) && dateProblem(text, past);
  return (
    <label class={`field${bad ? ' err' : ''}`}>
      <span class="l">{label}</span>
      <span class="inp">
        <input
          id={id}
          class="mono"
          inputMode="numeric"
          placeholder="MM/DD/YYYY"
          autocomplete="off"
          maxLength={10}
          value={text}
          onBlur={() => setLeft(true)}
          onInput={(e) => {
            const t = maskDate(val(e));
            if (t !== val(e)) (e.currentTarget as HTMLInputElement).value = t;
            setText(t);
            const p = readDate(t);
            onDate(p ? isoDate(p) : t || null);
          }}
        />
      </span>
      {bad && <span class="f-msg">{bad}</span>}
    </label>
  );
}

type FieldsUp = (up: (fields: FieldDraft[]) => FieldDraft[]) => void;
const textField = (name: string, value: string): FieldDraft => ({ name, value, type: 0, linkedId: null });

/** Identity form (3A): the usual fields, birth date and gender, and a chip for each of the rest. A field with a value always shows. */
export function IdentityForm({ identity: i, fields, name, onId, onFields, onName, nameErr }: { identity: Vals; fields: FieldDraft[]; name: string; onId: (p: Vals) => void; onFields: FieldsUp; onName: (v: string) => void; nameErr: string | null }) {
  const [added, setAdded] = useState<string[]>([]);
  const [show, setShow] = useState<Record<string, boolean>>({});
  const x = extrasOf(fields);
  const xVal = (part: Extra) => (x.at[part] !== undefined ? (fields[x.at[part]!]?.value ?? '') : '');
  const setX = (part: Extra, v: string | null) => onFields((f) => withExtra(f, part, v, textField));
  const docOpen = (num: string, a: Extra, b: Extra) => i[num] != null || x.at[a] !== undefined || x.at[b] !== undefined;
  const has = (k: string) =>
    added.includes(k) ||
    (k === 'doc:passport' ? docOpen('passportNumber', 'passportCountry', 'passportExpiry') : k === 'doc:license' ? docOpen('licenseNumber', 'licenseState', 'licenseExpiry') : k.startsWith('x:') ? x.at[k.slice(2) as Extra] !== undefined : i[k] != null);
  const keep = (k: string) => setAdded((a) => (a.includes(k) ? a : [...a, k]));
  const open = EXTRA.filter(([k]) => has(k));
  const closed = EXTRA.filter(([k]) => !has(k));
  const drop = (k: string) => {
    setAdded((a) => a.filter((y) => y !== k));
    if (k === 'doc:passport') {
      onId({ passportNumber: null });
      onFields((f) => withExtra(withExtra(f, 'passportCountry', null, textField), 'passportExpiry', null, textField));
    } else if (k === 'doc:license') {
      onId({ licenseNumber: null });
      onFields((f) => withExtra(withExtra(f, 'licenseState', null, textField), 'licenseExpiry', null, textField));
    } else if (k.startsWith('x:')) setX(k.slice(2) as Extra, null);
    else onId({ [k]: null });
  };
  const removeBtn = (k: string, label: string) => (
    <button type="button" class="ib" aria-label={`Remove ${label.toLowerCase()}`} title="Remove" onClick={() => drop(k)}>
      <X />
    </button>
  );
  const text = (k: string, label: string | null, ph = '', extra: Record<string, unknown> = {}) => (
    <label class="field">
      {label && <span class="l">{label}</span>}
      <span class="inp">
        <input id={`f-${k}`} aria-label={label ?? ph} placeholder={ph} autocomplete="off" value={i[k] ?? ''} onInput={(e) => onId({ [k]: val(e) || null })} {...extra} />
      </span>
    </label>
  );
  const xText = (part: Extra, label: string, chip?: string) => (
    <label class="field" onInput={chip ? () => keep(chip) : undefined}>
      <span class="l">{label}</span>
      <span class="inp">
        <input id={`f-${part}`} autocomplete="off" value={xVal(part)} onInput={(e) => setX(part, val(e) || null)} />
        {chip && removeBtn(chip, label)}
      </span>
    </label>
  );
  const secret = (k: string, label: string, hint: string) => (
    <label class="field">
      <span class="l">
        {label}
        <small>Hidden when you view it</small>
      </span>
      <span class="inp">
        <input id={`f-${k}`} aria-label={hint} class={`mono${show[k] ? '' : ' masked'}`} autocomplete="off" spellcheck={false} value={i[k] ?? ''} onInput={(e) => onId({ [k]: val(e) })} />
        <EyeBtn on={!!show[k]} what={hint.toLowerCase()} onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))} />
      </span>
    </label>
  );
  const doc = (k: string, title: string, num: string, issuer: Extra, issuerLabel: string, expiry: Extra) => (
    <div class="doc" onInput={() => keep(k)}>
      <div class="doc-h">
        {title}
        {removeBtn(k, title)}
      </div>
      {secret(num, 'Number', `${title} number`)}
      <div class="two">
        {xText(issuer, issuerLabel)}
        <DateBox id={`f-${expiry}`} label="Expires" value={x.values[expiry]} past={false} onDate={(v) => setX(expiry, v)} />
      </div>
    </div>
  );
  const genders = x.values.gender && !GENDERS.includes(x.values.gender) ? [...GENDERS, x.values.gender] : GENDERS;
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
      <div class="two">
        <DateBox id="f-dob" label="Date of birth" value={x.values.dob} past onDate={(v) => setX('dob', v)} />
        <label class="field">
          <span class="l">Gender</span>
          <span class="inp">
            <select id="f-gender" value={x.values.gender ?? ''} onChange={(e) => setX('gender', (e.currentTarget as HTMLSelectElement).value || null)}>
              <option value="">Choose</option>
              {genders.map((g) => (
                <option value={g}>{g}</option>
              ))}
            </select>
          </span>
        </label>
      </div>
      {text('email', 'Email', '', { type: 'email', spellcheck: false })}
      {text('phone', 'Phone', '', { type: 'tel' })}
      {text('address1', 'Address', 'Street address')}
      <div class="three">
        {text('city', null, 'City')}
        {text('state', null, 'State')}
        {text('postalCode', null, 'ZIP')}
      </div>
      {open.map(([k, label, isSecret]) =>
        k === 'doc:passport' ? (
          doc(k, 'Passport', 'passportNumber', 'passportCountry', 'Country', 'passportExpiry')
        ) : k === 'doc:license' ? (
          doc(k, "Driver's license", 'licenseNumber', 'licenseState', 'State', 'licenseExpiry')
        ) : k.startsWith('x:') ? (
          xText(k.slice(2) as Extra, label, k)
        ) : (
          <label class="field">
            <span class="l">
              {label}
              {isSecret && <small>Hidden when you view it</small>}
            </span>
            <span class="inp">
              <input id={`f-${k}`} class={isSecret ? `mono${show[k] ? '' : ' masked'}` : ''} autocomplete="off" spellcheck={false} value={i[k] ?? ''} onInput={(e) => onId({ [k]: val(e) })} />
              {isSecret && <EyeBtn on={!!show[k]} what={label.toLowerCase()} onClick={() => setShow((s) => ({ ...s, [k]: !s[k] }))} />}
              {removeBtn(k, label)}
            </span>
          </label>
        ),
      )}
      {closed.length > 0 && (
        <div class="add-chips">
          {closed.map(([k, label]) => (
            <button
              type="button"
              class="add-chip"
              onClick={() => {
                setAdded((a) => [...a, k]);
                const focus = k === 'doc:passport' ? 'f-passportNumber' : k === 'doc:license' ? 'f-licenseNumber' : `f-${k.replace(/^x:/, '')}`;
                setTimeout(() => document.getElementById(focus)?.focus(), 0);
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
