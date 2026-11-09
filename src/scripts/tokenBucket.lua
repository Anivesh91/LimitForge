local key = KEYS[1]
local now = tonumber(ARGV[1])
if ARGV[6] == '1' then
    if redis.replicate_commands then redis.replicate_commands() end
    local clock = redis.call("TIME")
    now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
end
local capacity = tonumber(ARGV[2])
local refillRate = tonumber(ARGV[3])
local refillIntervalMs = tonumber(ARGV[4]) or 1000
local cost = tonumber(ARGV[5]) or 1

if refillIntervalMs <= 0 then
    refillIntervalMs = 1000
end

local refillPerMs = refillRate / refillIntervalMs

local data = redis.call("HMGET", key, "tokens", "lastRefill")
local rawTokens = data[1]
local rawLastRefill = data[2]

local currentTokens = capacity
local lastRefill = now

if rawTokens and rawLastRefill then
    local prevTokens = tonumber(rawTokens)
    local prevLastRefill = tonumber(rawLastRefill)

    local elapsedMs = math.max(0, now - prevLastRefill)
    local tokensToAdd = elapsedMs * refillPerMs
    currentTokens = math.min(capacity, prevTokens + tokensToAdd)
    lastRefill = math.max(now, prevLastRefill)
end

local allowed = 0
local remaining = 0
local retryAfter = 0

if currentTokens >= cost then
    currentTokens = currentTokens - cost
    allowed = 1
    remaining = math.floor(currentTokens)
else
    allowed = 0
    remaining = math.floor(currentTokens)
    local neededTokens = cost - currentTokens
    local waitMs = neededTokens / refillPerMs
    retryAfter = math.max(1, math.ceil(waitMs / 1000))
end

redis.call("HSET", key, "tokens", tostring(currentTokens), "lastRefill", tostring(lastRefill))

local fullTimeMs = math.ceil(capacity / refillPerMs)
local fullTimeSec = math.ceil(fullTimeMs / 1000)
local ttlSeconds = math.max(60, fullTimeSec * 2)
redis.call("EXPIRE", key, ttlSeconds)

local reset
if allowed == 1 then
    local timeToFullMs = math.max(0, (capacity - currentTokens) / refillPerMs)
    reset = math.max(1, math.ceil(timeToFullMs / 1000))
else
    reset = retryAfter
end

return { allowed, remaining, reset, retryAfter }
