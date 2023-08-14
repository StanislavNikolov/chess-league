export async function sendEmail(subject: string, body: string, to: string) {
	const email = new FormData();
	email.append("from", `Tiny Chess League <info@chess.stjo.dev>`);
	email.append("to", to);
	email.append("subject", subject);
	email.append("text", body);

	console.log("Sending email", email);

	const res = await fetch("https://api.eu.mailgun.net/v3/chess.stjo.dev/messages", {
		method: "POST",
		headers: { Authorization: "Basic " + btoa(`api:${process.env.MAILGUN_KEY}`) },
		body: email
	});
	console.log(res);
	console.log(await res.text());
}