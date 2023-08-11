# Intro
TODO

# Setup
## External dependencies
```sh
# Install postgres and bubblewrap for secure execution
apt install bubblewrap postgres

# Install dotnet to compile the bots
curl -fsSL https://dotnet.microsoft.com/download/dotnet/scripts/v1/dotnet-install.sh | bash

# Install bun
curl -fsSL https://bun.sh/install | bash

mkdir compiled
```

## Database
```
psql postgres
> CREATE USER chess WITH ENCRYPTED PASSWORD 'RANDOM_PASSWORD';
> CREATE DATABASE chess;
> GRANT ALL PRIVILEGES ON DATABASE chess TO chess;
> \c chess
> GRANT ALL ON SCHEMA public TO chess;
cat > .env
PGDATABASE=chess
PGUSERNAME=chess
PGPASSWORD=RANDOM_PASSWORD
```

## The server itself
After that, you can develop or run as any other bun project.
```sh
bun install
bun backend/index.ts
```

# Architecture
TODO
