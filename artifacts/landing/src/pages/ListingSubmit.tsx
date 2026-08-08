import { useState, useRef } from "react";
import { Upload, X, Check, Home as HomeIcon, Loader2 } from "lucide-react";

// Public, unauthenticated on purpose — the whole point is a link anyone can
// open (a manager, or the listing owner themselves) without needing an
// account. Submissions land in a review queue (/listings) before anything
// reaches the live site or the bot's catalog.

const FIELD_LABEL = "block text-xs font-semibold text-white/50 uppercase tracking-wider mb-1.5";
const INPUT = "w-full px-3.5 py-2.5 rounded-lg text-sm text-white outline-none focus:ring-1 focus:ring-[#4db8ff]/50 placeholder-white/20";
const INPUT_STYLE = { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(77,184,255,0.18)" };

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className={FIELD_LABEL}>{label}{required && <span className="text-[#f87171] ml-1">*</span>}</label>
      {children}
    </div>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={INPUT} style={INPUT_STYLE} />;
}

function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={INPUT} style={{ ...INPUT_STYLE, background: "rgba(13,31,53,0.9)" }}>
      {children}
    </select>
  );
}

export default function ListingSubmit() {
  const [listingType, setListingType] = useState<"sale" | "rent">("sale");
  const [ownership, setOwnership] = useState("freehold");
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const arr = Array.from(list);
    setFiles((prev) => [...prev, ...arr]);
    setPreviews((prev) => [...prev, ...arr.map((f) => URL.createObjectURL(f))]);
  }

  function removeFile(i: number) {
    setFiles((prev) => prev.filter((_, j) => j !== i));
    setPreviews((prev) => prev.filter((_, j) => j !== i));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const form = e.currentTarget;
    const fd = new FormData(form);
    fd.set("listingType", listingType);
    fd.set("ownership", ownership);
    for (const f of files) fd.append("images", f);

    if (!fd.get("title") || !fd.get("area")) {
      setError("Название и район — обязательные поля.");
      return;
    }
    if (files.length === 0) {
      setError("Добавьте хотя бы одно фото.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/public/listing-submissions", { method: "POST", body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Ошибка ${res.status}`);
      }
      setDone(true);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center px-5" style={{ background: "linear-gradient(135deg,#060f1e 0%,#0d1f35 100%)" }}>
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-2xl mx-auto mb-5 flex items-center justify-center" style={{ background: "rgba(52,211,153,0.15)" }}>
            <Check className="w-7 h-7" style={{ color: "#34d399" }} />
          </div>
          <h1 className="text-xl font-bold text-white mb-2">Спасибо!</h1>
          <p className="text-sm text-white/50">
            Объект отправлен на проверку. Наша команда посмотрит и опубликует его на сайте в ближайшее время.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen text-white pb-16" style={{ background: "linear-gradient(135deg,#060f1e 0%,#0d1f35 100%)" }}>
      <div className="sticky top-0 z-40 border-b px-5 py-3.5 flex items-center gap-2"
        style={{ background: "rgba(6,15,30,0.93)", borderColor: "rgba(77,184,255,0.1)", backdropFilter: "blur(12px)" }}>
        <a href="/" className="text-white/25 hover:text-white/60 transition-colors mr-1"><HomeIcon className="w-4 h-4" /></a>
        <div>
          <h1 className="text-sm font-bold text-white">Добавить объект</h1>
          <p className="text-[10px] text-white/25">Unicorn Property · заполните и отправьте на проверку</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="max-w-2xl mx-auto px-5 py-6 space-y-5">
        {error && (
          <div className="rounded-lg px-4 py-3 text-sm text-red-300" style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.25)" }}>
            {error}
          </div>
        )}

        {/* Тип сделки */}
        <div className="grid grid-cols-2 gap-3">
          {(["sale", "rent"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setListingType(v)}
              className="py-3 rounded-xl text-sm font-semibold border transition-all"
              style={{
                background: listingType === v ? "rgba(77,184,255,0.15)" : "rgba(255,255,255,0.03)",
                borderColor: listingType === v ? "rgba(77,184,255,0.4)" : "rgba(255,255,255,0.08)",
                color: listingType === v ? "#4db8ff" : "rgba(255,255,255,0.5)",
              }}>
              {v === "sale" ? "Продажа" : "Аренда"}
            </button>
          ))}
        </div>

        <div className="rounded-2xl border p-5 space-y-4" style={{ borderColor: "rgba(77,184,255,0.12)", background: "rgba(13,31,53,0.5)" }}>
          <Field label="Название объекта" required>
            <TextInput name="title" required placeholder="2BR Villa in Pererenan" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Район" required>
              <TextInput name="area" required placeholder="Pererenan" />
            </Field>
            <Field label="Тип объекта">
              <Select name="type" defaultValue="villa">
                <option value="villa">Villa</option>
                <option value="apartment">Apartment</option>
                <option value="land">Land</option>
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Спальни"><TextInput name="bedrooms" type="number" min={0} placeholder="2" /></Field>
            <Field label="Ванные"><TextInput name="bathrooms" type="number" min={0} placeholder="2" /></Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Площадь участка, м²"><TextInput name="landSize" type="number" min={0} placeholder="200" /></Field>
            <Field label="Площадь застройки, м²"><TextInput name="buildSize" type="number" min={0} placeholder="150" /></Field>
          </div>
        </div>

        <div className="rounded-2xl border p-5 space-y-4" style={{ borderColor: "rgba(77,184,255,0.12)", background: "rgba(13,31,53,0.5)" }}>
          <span className="text-xs font-bold text-white/40 uppercase tracking-wider">Цена</span>
          {listingType === "sale" ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Цена, USD"><TextInput name="priceUsd" type="number" min={0} placeholder="450000" /></Field>
              <Field label="Leasehold цена, USD"><TextInput name="leaseholdPriceUsd" type="number" min={0} placeholder="(если применимо)" /></Field>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Цена в месяц, IDR" required>
                <TextInput name="monthlyPriceIdr" type="number" min={0} placeholder="50000000" />
              </Field>
              <Field label="Цена в год, IDR"><TextInput name="yearlyPriceIdr" type="number" min={0} placeholder="550000000" /></Field>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Владение">
              <Select name="ownership" value={ownership} onChange={(e) => setOwnership(e.target.value)}>
                <option value="freehold">Freehold</option>
                <option value="leasehold">Leasehold</option>
                <option value="freehold & leasehold">Freehold & Leasehold</option>
              </Select>
            </Field>
            {ownership !== "freehold" && (
              <Field label="Срок аренды, лет"><TextInput name="leaseYears" type="number" min={0} placeholder="25" /></Field>
            )}
          </div>
        </div>

        <div className="rounded-2xl border p-5 space-y-4" style={{ borderColor: "rgba(77,184,255,0.12)", background: "rgba(13,31,53,0.5)" }}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Цель">
              <Select name="purpose" defaultValue="living & investment">
                <option value="investment">Investment</option>
                <option value="living & investment">Living & Investment</option>
                <option value="living">Living</option>
              </Select>
            </Field>
            <Field label="Зона">
              <Select name="zone" defaultValue="mixed">
                <option value="touristic">Touristic</option>
                <option value="mixed">Mixed</option>
                <option value="residential">Residential</option>
              </Select>
            </Field>
          </div>

          <Field label="Особенности (через запятую)">
            <TextInput name="features" placeholder="Pool, Private Garden, Rooftop" />
          </Field>

          <Field label="Описание">
            <textarea name="description" rows={4} placeholder="Коротко опишите объект..."
              className="w-full px-3.5 py-2.5 rounded-lg text-sm text-white outline-none focus:ring-1 focus:ring-[#4db8ff]/50 resize-none placeholder-white/20"
              style={INPUT_STYLE} />
          </Field>

          <Field label="Ссылка на видео (необязательно)">
            <TextInput name="videoUrl" placeholder="https://..." />
          </Field>
        </div>

        <div className="rounded-2xl border p-5 space-y-4" style={{ borderColor: "rgba(77,184,255,0.12)", background: "rgba(13,31,53,0.5)" }}>
          <Field label="Фото объекта" required>
            <button type="button" onClick={() => fileInputRef.current?.click()}
              className="w-full py-8 rounded-xl border-2 border-dashed flex flex-col items-center gap-2 transition-colors hover:border-[#4db8ff]/40"
              style={{ borderColor: "rgba(77,184,255,0.2)" }}>
              <Upload className="w-6 h-6 text-[#4db8ff]/60" />
              <span className="text-sm text-white/50">Нажмите, чтобы выбрать фото</span>
              <span className="text-[10px] text-white/25">Можно выбрать сразу несколько</span>
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden"
              onChange={(e) => addFiles(e.target.files)} />
          </Field>

          {previews.length > 0 && (
            <div className="grid grid-cols-4 gap-2">
              {previews.map((src, i) => (
                <div key={i} className="relative aspect-square rounded-lg overflow-hidden group">
                  <img src={src} alt="" className="w-full h-full object-cover" />
                  <button type="button" onClick={() => removeFile(i)}
                    className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <X className="w-3 h-3 text-white" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border p-5 space-y-4" style={{ borderColor: "rgba(77,184,255,0.12)", background: "rgba(13,31,53,0.5)" }}>
          <span className="text-xs font-bold text-white/40 uppercase tracking-wider">Кто отправляет (необязательно)</span>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Имя"><TextInput name="submitterName" placeholder="Ваше имя" /></Field>
            <Field label="Контакт"><TextInput name="submitterContact" placeholder="WhatsApp / телефон" /></Field>
          </div>
        </div>

        <button type="submit" disabled={submitting}
          className="w-full py-3.5 rounded-xl font-semibold text-sm text-white flex items-center justify-center gap-2 disabled:opacity-50 transition-all"
          style={{ background: "linear-gradient(135deg,#2563eb,#3b9eff)" }}>
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {submitting ? "Отправляем..." : "Отправить на проверку"}
        </button>
      </form>
    </div>
  );
}
