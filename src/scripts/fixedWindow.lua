local key = KEYS[1]
local windowMs = tonumber(ARGV[1])

if redis.replicate_commands then redis.replicate_commands() end
local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)

-- Keep timestamps and expiry calculations within Lua's exact integer range.
if not windowMs or windowMs <= 0 or windowMs > 9007199254740991 - now then
    return redis.error_reply("SmartRate: fixed window duration is out of range")
end

local value = redis.call("GET", key)
local count = "0"
local start = now
local legacyUntil = 0

if value then
    local ttl = redis.call("PTTL", key)
    if ttl == -1 then
        return { 0, -1 }
    end

    local savedCount, savedStart, savedLegacyUntil = string.match(value, "^lf1|(%-?%d+)|(%d+)|(%d+)$")
    if savedCount then
        count = savedCount
        start = tonumber(savedStart)
        legacyUntil = tonumber(savedLegacyUntil)
        if not start or not legacyUntil or start > 9007199254740991 - windowMs or legacyUntil > 9007199254740991 then
            return redis.error_reply("SmartRate: invalid fixed window state")
        end
    elseif string.match(value, "^%-?%d+$") then
        -- The old counter does not record when its window started. Preserve it
        -- until both its remaining TTL and one new window have elapsed.
        count = value
        legacyUntil = now + math.max(0, ttl)
    else
        return redis.error_reply("SmartRate: invalid fixed window state")
    end
end

local deadline = math.max(start + windowMs, legacyUntil)
if now >= deadline then
    count = "0"
    start = now
    legacyUntil = 0
    deadline = start + windowMs
end

-- Increment decimal strings exactly, preserving Redis INCR's signed-64-bit limit.
local negative = string.sub(count, 1, 1) == "-"
if negative then count = string.sub(count, 2) end
count = string.gsub(count, "^0+", "")
if count == "" then count = "0" end
local maxCount = negative and "9223372036854775808" or "9223372036854775807"
if #count > #maxCount or (#count == #maxCount and (count > maxCount or (not negative and count == maxCount))) then
    return redis.error_reply("SmartRate: fixed window counter overflow")
end
if negative and count ~= "0" then
    local pos = #count
    while pos > 0 and string.sub(count, pos, pos) == "0" do pos = pos - 1 end
    local digit = tonumber(string.sub(count, pos, pos)) - 1
    count = string.sub(count, 1, pos - 1) .. tostring(digit) .. string.rep("9", #count - pos)
    count = string.gsub(count, "^0+", "")
    if count == "" then count = "0" else count = "-" .. count end
else
    local pos = #count
    while pos > 0 and string.sub(count, pos, pos) == "9" do pos = pos - 1 end
    if pos == 0 then
        count = "1" .. string.rep("0", #count)
    else
        local digit = tonumber(string.sub(count, pos, pos)) + 1
        count = string.sub(count, 1, pos - 1) .. tostring(digit) .. string.rep("0", #count - pos)
    end
end

local ttlMs = math.max(1, math.ceil(deadline - now))
local state = "lf1|" .. count .. "|" .. string.format("%.0f", start) .. "|" .. string.format("%.0f", legacyUntil)
-- SET and expiration happen together, including during legacy migration.
redis.call("SET", key, state, "PX", ttlMs)
-- Return the decimal string so Lua's floating-point conversion cannot turn a
-- large positive counter into a negative signed Redis reply.
return { count, ttlMs }
