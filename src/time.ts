// Date/time helpers: converts timestamps to New-York date components
// and formats for time-zone–aware comparisons.
export function toNyParts(dateInput: string | Date, timeZone = 'America/New_York') {
    const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).formatToParts(date);

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return {
        year: Number(get('year')),
        month: Number(get('month')),
        day: Number(get('day')),
        hour: Number(get('hour')),
        minute: Number(get('minute')),
        second: Number(get('second')),
        date: `${get('year')}-${get('month')}-${get('day')}`,
        hhmm: `${get('hour')}:${get('minute')}`,
    };
}

export function todayNyDate(): string {
    return toNyParts(new Date()).date;
}

export function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}