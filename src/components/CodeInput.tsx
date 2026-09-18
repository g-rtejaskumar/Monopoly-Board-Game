import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { normalizeCode } from '../game/types'
import './CodeInput.css'

interface CodeInputProps {
  value: string
  onChange: (value: string) => void
  onComplete?: (value: string) => void
  disabled?: boolean
  autoFocus?: boolean
}

export function CodeInput({ value, onChange, onComplete, disabled, autoFocus }: CodeInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>(Array(6).fill(null))
  const [focusedIdx, setFocusedIdx] = useState(0)

  const handleChange = (idx: number, raw: string) => {
    const typed = normalizeCode(raw)
    if (!typed) {
      if (raw === '') {
        const chars = value.padEnd(6, ' ').split('')
        chars[idx] = ' '
        onChange(normalizeCode(chars.join('')))
      }
      return
    }
    if (typed.length > 1) {
      // multi-character input (paste or fast typing)
      const merged = normalizeCode(value.slice(0, idx) + typed)
      onChange(merged)
      const target = Math.min(idx + typed.length, 5)
      refs.current[target]?.focus()
      if (merged.length === 6) onComplete?.(merged)
      return
    }
    const chars = value.padEnd(6, ' ').split('')
    chars[idx] = typed
    const next = normalizeCode(chars.join(''))
    onChange(next)
    if (idx < 5) refs.current[idx + 1]?.focus()
    if (next.length === 6) onComplete?.(next)
  }

  const handleKeyDown = (idx: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault()
      const chars = value.padEnd(6, ' ').split('')
      if (chars[idx] !== ' ') {
        chars[idx] = ' '
        onChange(normalizeCode(chars.join('')))
      } else if (idx > 0) {
        chars[idx - 1] = ' '
        onChange(normalizeCode(chars.join('')))
        refs.current[idx - 1]?.focus()
      }
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      e.preventDefault()
      refs.current[idx - 1]?.focus()
    } else if (e.key === 'ArrowRight' && idx < 5) {
      e.preventDefault()
      refs.current[idx + 1]?.focus()
    }
  }

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const text = normalizeCode(e.clipboardData.getData('text'))
    if (!text) return
    onChange(text)
    const target = Math.min(text.length, 5)
    refs.current[target]?.focus()
    if (text.length === 6) onComplete?.(text)
  }

  return (
    <div className="code-input" role="group" aria-label="Room code">
      {Array.from({ length: 6 }).map((_, i) => {
        const char = value[i] ?? ''
        const isFilled = char !== '' && char !== ' '
        return (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el
            }}
            className={`code-cell ${focusedIdx === i ? 'active' : ''}`}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={6}
            disabled={disabled}
            value={char}
            data-filled={isFilled || undefined}
            aria-label={`Room code character ${i + 1}`}
            autoFocus={autoFocus && i === 0}
            onFocus={() => setFocusedIdx(i)}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onPaste={handlePaste}
          />
        )
      })}
    </div>
  )
}
