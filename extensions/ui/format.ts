// Small formatting helpers shared by the footer widgets.

export function clampPercent(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, Math.round(n)));
}

export function formatDurationLeft(iso: string, now = new Date()): string {
	const ms = new Date(iso).getTime() - now.getTime();
	if (!Number.isFinite(ms)) return "?";
	if (ms <= 0) return "now";

	const totalMin = Math.floor(ms / 60_000);
	const days = Math.floor(totalMin / (60 * 24));
	const hours = Math.floor((totalMin % (60 * 24)) / 60);
	const mins = totalMin % 60;

	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (days === 0 && (mins > 0 || parts.length === 0)) parts.push(`${mins}m`);
	return parts.join(" ");
}
