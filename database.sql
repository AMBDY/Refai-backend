-- 1. USERS (Authentication & Roles)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    first_name VARCHAR(50) NOT NULL,
    last_name VARCHAR(50) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('super_admin', 'league_owner', 'team_manager', 'referee', 'viewer')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. LEAGUES
CREATE TABLE leagues (
    id SERIAL PRIMARY KEY,
    owner_id INT REFERENCES users(id),
    name VARCHAR(100) NOT NULL,
    location VARCHAR(100),
    league_type VARCHAR(20),
    plan VARCHAR(20) DEFAULT 'free',
    status VARCHAR(20) DEFAULT 'Pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. TEAMS
CREATE TABLE teams (
    id SERIAL PRIMARY KEY,
    league_id INT REFERENCES leagues(id),
    manager_id INT REFERENCES users(id),
    name VARCHAR(100) NOT NULL,
    logo_url VARCHAR(255),
    status VARCHAR(20) DEFAULT 'Active',
    deleted_at TIMESTAMP NULL
);

-- 4. PLAYERS (Holds the images for the 3D Graphics)
CREATE TABLE players (
    id SERIAL PRIMARY KEY,
    team_id INT REFERENCES teams(id),
    name VARCHAR(100) NOT NULL,
    jersey_number INT NOT NULL,
    position VARCHAR(20) NOT NULL,
    passport_url VARCHAR(255),
    fullbody_url VARCHAR(255),
    goals INT DEFAULT 0,
    yellow_cards INT DEFAULT 0,
    red_cards INT DEFAULT 0,
    status VARCHAR(20) DEFAULT 'Active',
    reason VARCHAR(100) NULL
);

-- 5. MATCHES
CREATE TABLE matches (
    id SERIAL PRIMARY KEY,
    league_id INT REFERENCES leagues(id),
    home_team_id INT REFERENCES teams(id),
    away_team_id INT REFERENCES teams(id),
    match_type VARCHAR(20) DEFAULT 'competitive',
    date DATE NOT NULL,
    time TIME NOT NULL,
    venue VARCHAR(100),
    status VARCHAR(20) DEFAULT 'scheduled',
    home_score INT DEFAULT 0,
    away_score INT DEFAULT 0,
    stream_url VARCHAR(255)
);

-- 6. MATCH EVENTS (The Live Timeline)
CREATE TABLE match_events (
    id SERIAL PRIMARY KEY,
    match_id INT REFERENCES matches(id),
    event_type VARCHAR(20) NOT NULL, -- Goal, Yellow, Red, Sub
    team_id INT REFERENCES teams(id),
    player_name VARCHAR(100),
    minute INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);