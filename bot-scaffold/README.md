Participants submit their `MyBot.cs` file, that they wrote with the [official
scaffolding C# project](https://github.com/SebLague/Chess-Challenge) in mind.

Sadly, it contains way too much stuff that I don't want running for this
competition (like board rendering with raylib), while also duplicating logic
that is handled by the backend (move verification, pairing of multiple bots).

This scaffolding should provide the same API, so that players wouldn't need to
make any changes. When compiled, `Program.cs` implements the simple interface
that the [webui](../) expects to see, precisely:
 1) The bot should wait for a FEN string and time left in ms to appear on stdin on separate lines.
 2) The bot should print the move it chose on stdout.
