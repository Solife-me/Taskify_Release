export class EventCache {
    seenIds = new Set();
    maxSize;
    constructor(maxSize = 2048) {
        this.maxSize = Math.max(256, maxSize);
    }
    has(event) {
        if (!event || typeof event.id !== "string")
            return false;
        return this.seenIds.has(event.id);
    }
    add(event) {
        if (!event?.id)
            return;
        this.seenIds.add(event.id);
        if (this.seenIds.size > this.maxSize) {
            const [first] = this.seenIds;
            if (first)
                this.seenIds.delete(first);
        }
    }
}
