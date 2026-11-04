
local key = KEYS[1]
local now = tonumber(ARGV[1])
if ARGV[5] == '1' then
    if redis.replicate_commands then redis.replicate_commands() end
    local clock = redis.call("TIME")
    now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
end
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

-- Redis expiry uses whole milliseconds. Validate before modifying the sorted set
-- and round up so a fractional window cannot leave a key without a TTL.
if not windowMs or windowMs <= 0 or windowMs > 9007199254740991 - math.max(0, now) then
    return redis.error_reply("SmartRate: sliding window duration is out of range")
end
local ttlMs = math.max(1, math.ceil(windowMs))

local cutoff = now - ttlMs

redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)

local currentCount = redis.call("ZCARD", key)
local allowed = 0

if currentCount < limit then
    redis.call("ZADD", key, now, member)
    currentCount = currentCount + 1
    allowed = 1
end

local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
local oldestScore = (oldest and #oldest >= 2) and tonumber(oldest[2]) or now

redis.call("PEXPIRE", key, ttlMs)

return { allowed, currentCount, oldestScore, now }
