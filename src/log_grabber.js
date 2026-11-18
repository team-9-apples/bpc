export async function get_logs(db,userid,org){
    try{

        if( await (db.prepare("SELECT  1 FROM users WHERE id=? AND role='REQUEST_USER' ").bind(userid).first())){
            return("wrong credentials") ;
        }
        else {

            let result =await db.prepare('SELECT id,started_at from requests WHERE  organisation_id=? ORDER BY started_at DESC').bind(org).all();
            return result;

        }}
    catch(err){
        return(err.message);}
}
export async function detail_log(db,logid,org){
    try {


        let log =await db.prepare('SELECT * FROM CHECK_RESULTS WHERE id=? AND organisation_id').bind(logid,org).all();
        return log
    }catch(err){
        return(err.message);
    }
}